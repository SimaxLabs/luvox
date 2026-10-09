import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, accessSync, rmSync, statSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getMfluxImageModel, getMfluxImageResolution, MFLUX_IMAGE_MODELS } from "../shared/imageModels.js";
import { rasterMediaType, type ImageGenerationResponse, type LocalMfluxProgress } from "../shared/imageTypes.js";
import type { LocalH3FrameFitId } from "../shared/localH3.js";
import type { LocalMfluxGenerateImageInput } from "./validation.js";
import { MFLUX_WORKER_SOURCE } from "./mfluxWorker.js";

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCE_PIXELS = 4_096 * 4_096;
const MAX_REFERENCE_ASPECT_RATIO = 16;
const MFLUX_TEMP_PREFIX = "luvox-mflux-";
const MFLUX_OWNER_FILE = ".luvox-owned";
const MFLUX_OWNER_KIND = "luvox-mflux-request";
const MFLUX_WORKER_KIND = "luvox-mflux-worker";
const MFLUX_OWNER_MAX_BYTES = 4_096;
const execFileAsync = promisify(execFile);
const activeDirectories = new Set<string>();
const shutdownController = new AbortController();
let activeChild: ChildProcess | undefined;
let activeCompletion: Promise<void> | undefined;
let generationReserved = false;
let stopActive: (() => void) | undefined;
let shuttingDown = false;
let storageBlocked = false;
let warmWorker: {
  child: ChildProcess;
  key: string;
  closed: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
} | undefined;

export class LocalMfluxError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocalMfluxError";
  }
}

export function isLocalMfluxSupported(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

function resolveMfluxBinary(
  model: (typeof MFLUX_IMAGE_MODELS)[number],
  executable: string = model.executable,
): string | undefined {
  const configured = process.env[model.environmentVariable]?.trim();
  if (configured && !path.isAbsolute(configured)) return undefined;
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executable));
  const candidates = configured
    ? executable === model.executable
      ? [configured]
      : [path.join(path.dirname(configured), executable), ...pathCandidates]
    : pathCandidates;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next server-controlled PATH entry.
    }
  }
  return undefined;
}

export function getAvailableLocalMfluxModels(): string[] {
  if (!isLocalMfluxSupported() || storageBlocked) return [];
  try {
    timeoutMilliseconds();
    timeoutMilliseconds("MFLUX_DOWNLOAD_TIMEOUT_MINUTES", 120);
    keepAliveMilliseconds();
  } catch {
    return [];
  }
  return MFLUX_IMAGE_MODELS.filter((model) => resolveMfluxBinary(model)).map((model) => model.id);
}

function timeoutMilliseconds(name = "MFLUX_TIMEOUT_MINUTES", fallback = 30): number {
  const minutes = Number(process.env[name] || fallback);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
    throw new LocalMfluxError(
      `${name} must be between 1 and 240.`,
      503,
      "local_mflux_configuration_error",
      false,
    );
  }
  return minutes * 60_000;
}

function keepAliveMilliseconds(): number {
  const minutes = Number(process.env.MFLUX_KEEP_ALIVE_MINUTES ?? 5);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
    throw new LocalMfluxError(
      "MFLUX_KEEP_ALIVE_MINUTES must be between 0 and 240.",
      503,
      "local_mflux_configuration_error",
      false,
    );
  }
  return minutes * 60_000;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "HF_HOME", "HF_HUB_CACHE", "MFLUX_CACHE_DIR"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The detached process group may already have exited.
  }
}

function assertMfluxMayContinue(signal?: AbortSignal): void {
  if (!shuttingDown && !signal?.aborted) return;
  throw new LocalMfluxError("MFLUX generation was stopped.", 499, "local_mflux_aborted", false);
}

function processDefinitelyStopped(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function stopOwnedProcessGroup(
  directory: string,
  binary: string | undefined,
  worker = false,
): Promise<boolean> {
  if (!binary) return false;
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pgid=,command="],
    { encoding: "utf8", env: childEnvironment(), maxBuffer: 1024 * 1024, timeout: 5_000 },
  );
  const promptPath = path.join(directory, worker ? "worker.py" : "prompt.txt");
  const processGroups = new Set(stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2].includes(binary) && match[2].includes(promptPath) ? [Number(match[1])] : [];
  }));
  if (processGroups.size === 0) return true;
  if (processGroups.size !== 1) return false;
  const [processGroup] = processGroups;
  if (!Number.isInteger(processGroup) || processGroup < 1) return false;

  try {
    process.kill(-processGroup, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
  for (let attempt = 0; attempt < 25 && processGroupExists(processGroup); attempt += 1) await delay(100);
  if (processGroupExists(processGroup)) {
    try {
      process.kill(-processGroup, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  }
  for (let attempt = 0; attempt < 10 && processGroupExists(processGroup); attempt += 1) await delay(50);
  return !processGroupExists(processGroup);
}

export async function initializeLocalMfluxStorage(): Promise<void> {
  if (!isLocalMfluxSupported()) return;
  storageBlocked = false;
  const temporaryDirectory = os.tmpdir();
  let entries;
  try {
    entries = await readdir(temporaryDirectory, { withFileTypes: true });
  } catch {
    storageBlocked = true;
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MFLUX_TEMP_PREFIX)) continue;
    const candidate = path.join(temporaryDirectory, entry.name);
    let owned = false;
    try {
      const candidateInfo = await lstat(candidate);
      if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) continue;
      if (typeof process.getuid === "function" && candidateInfo.uid !== process.getuid()) continue;
      const ownerPath = path.join(candidate, MFLUX_OWNER_FILE);
      const ownerInfo = await lstat(ownerPath);
      if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > MFLUX_OWNER_MAX_BYTES) continue;
      owned = true;
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
        kind?: unknown;
        version?: unknown;
        pid?: unknown;
        binary?: unknown;
      };
      if (
        (owner.kind !== MFLUX_OWNER_KIND && owner.kind !== MFLUX_WORKER_KIND) ||
        owner.version !== 1 ||
        typeof owner.pid !== "number"
      ) {
        owned = false;
        continue;
      }
      if (!processDefinitelyStopped(owner.pid)) {
        storageBlocked = true;
        continue;
      }
      if (!await stopOwnedProcessGroup(candidate, typeof owner.binary === "string" ? owner.binary : undefined, owner.kind === MFLUX_WORKER_KIND)) {
        storageBlocked = true;
        continue;
      }
      await rm(candidate, { recursive: true, force: true });
    } catch {
      if (owned) storageBlocked = true;
      // Unmarked, malformed, or inaccessible directories are not ours to remove.
    }
  }
}

async function inspectRaster(
  file: string,
  label: string,
  expectedSize?: { width: number; height: number },
  signal?: AbortSignal,
  decode = true,
): Promise<{ width: number; height: number }> {
  assertMfluxMayContinue(signal);
  const errorStatus = expectedSize ? 502 : 400;
  const errorType = expectedSize ? "local_mflux_output_error" : "local_mflux_image_error";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", file],
      { encoding: "utf8", env: childEnvironment(), killSignal: "SIGKILL", maxBuffer: 8_192, signal, timeout: 15_000 },
    ));
  } catch {
    assertMfluxMayContinue(signal);
    throw new LocalMfluxError(`${label} is not a decodable raster image.`, errorStatus, errorType, false);
  }
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_REFERENCE_PIXELS ||
    Math.max(width / height, height / width) > MAX_REFERENCE_ASPECT_RATIO
  ) {
    throw new LocalMfluxError(`${label} has unsupported dimensions.`, errorStatus, errorType, false);
  }
  if (expectedSize && (width !== expectedSize.width || height !== expectedSize.height)) {
    throw new LocalMfluxError(
      `MFLUX created ${width}x${height}; expected ${expectedSize.width}x${expectedSize.height}.`,
      502,
      "local_mflux_output_error",
      false,
    );
  }
  if (!decode) return { width, height };

  const probe = `${file}.probe.png`;
  try {
    await execFileAsync(
      "/usr/bin/sips",
      ["-s", "format", "png", file, "--out", probe],
      { encoding: "utf8", env: childEnvironment(), killSignal: "SIGKILL", maxBuffer: 8_192, signal, timeout: 30_000 },
    );
    const probeStats = await stat(probe);
    if (!probeStats.isFile() || probeStats.size < 1) throw new Error("empty probe");
  } catch {
    assertMfluxMayContinue(signal);
    throw new LocalMfluxError(`${label} is not a decodable raster image.`, errorStatus, errorType, false);
  } finally {
    await rm(probe, { force: true });
  }
  return { width, height };
}

async function frameReferenceImage(
  source: string,
  directory: string,
  target: { width: number; height: number },
  fit: LocalH3FrameFitId,
  generateMissing: boolean,
  signal?: AbortSignal,
): Promise<{ path: string; width: number; height: number }> {
  const sourceSize = await inspectRaster(source, "The reference image", undefined, signal, false);
  const scale = fit === "cover"
    ? Math.max(target.width / sourceSize.width, target.height / sourceSize.height)
    : Math.min(target.width / sourceSize.width, target.height / sourceSize.height);
  const round = fit === "cover" ? Math.ceil : Math.floor;
  const scaledWidth = Math.max(1, round(sourceSize.width * scale));
  const scaledHeight = Math.max(1, round(sourceSize.height * scale));
  const decoded = path.join(directory, "reference-decoded.png");
  const output = path.join(directory, "reference-framed.png");
  // FLUX.2 encodes references at their own aspect ratio; output size is supplied separately.
  const referenceSize = generateMissing ? { width: scaledWidth, height: scaledHeight } : target;
  const framingArgs = fit === "cover"
    ? ["--cropToHeightWidth", String(target.height), String(target.width)]
    : generateMissing ? [] : ["--padToHeightWidth", String(target.height), String(target.width), "--padColor", "000000"];
  try {
    await execFileAsync(
      "/usr/bin/sips",
      ["-s", "format", "png", source, "--out", decoded],
      { encoding: "utf8", env: childEnvironment(), killSignal: "SIGKILL", maxBuffer: 8_192, signal, timeout: 30_000 },
    );
    await execFileAsync(
      "/usr/bin/sips",
      [
        "--resampleHeightWidth", String(scaledHeight), String(scaledWidth),
        ...framingArgs,
        decoded,
        "--out", output,
      ],
      { encoding: "utf8", env: childEnvironment(), killSignal: "SIGKILL", maxBuffer: 8_192, signal, timeout: 30_000 },
    );
  } catch (error) {
    assertMfluxMayContinue(signal);
    const processError = error as {
      code?: string | number | null;
      killed?: boolean;
      signal?: string | null;
      stderr?: unknown;
    };
    const stderr = typeof processError.stderr === "string"
      ? processError.stderr
          .replaceAll(source, "the reference image")
          .replaceAll(decoded, "the decoded reference image")
          .replaceAll(output, "the framed image")
          .replaceAll(directory, "the temporary directory")
          .replace(/[\u0000-\u001f\u007f]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500)
      : "";
    const reason = processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "macOS sips produced too much diagnostic output."
      : processError.killed && processError.signal === "SIGKILL"
        ? "macOS sips exceeded the 30-second framing timeout."
        : stderr
          ? `macOS sips reported: ${stderr}`
          : `macOS sips exited${processError.code === undefined || processError.code === null ? "" : ` with status ${processError.code}`}.`;
    throw new LocalMfluxError(
      `Reference framing failed while converting ${sourceSize.width}x${sourceSize.height} to ${target.width}x${target.height} with ${fit} fit. ${reason}`,
      400,
      "local_mflux_image_error",
      false,
    );
  }
  const outputSize = await inspectRaster(output, "The framed reference image", undefined, signal);
  if (outputSize.width !== referenceSize.width || outputSize.height !== referenceSize.height) {
    throw new LocalMfluxError(
      `Reference framing produced ${outputSize.width}x${outputSize.height} instead of ${referenceSize.width}x${referenceSize.height} with ${fit} fit from a ${sourceSize.width}x${sourceSize.height} image.`,
      400,
      "local_mflux_image_error",
      false,
    );
  }
  return { path: output, ...outputSize };
}

function parseClock(value: string): number | undefined {
  if (!/^\d+(?::\d+){1,2}$/.test(value)) return undefined;
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function mfluxEngineError(code: string): LocalMfluxError {
  const failures: Record<string, [string, boolean]> = {
    access: ["Model download requires Hugging Face access. Accept the model's terms if required and run hf auth login on the Luvox host, then try again.", false],
    resource_missing: ["A required model resource is unavailable on Hugging Face. Check the model's availability and update MFLUX before trying again.", false],
    network: ["Could not fetch required model resources. Check the Luvox host's internet connection and try again; cached resources are kept.", true],
    disk_full: ["MFLUX ran out of disk space. Free space for the model cache and temporary files on the Luvox host, then try again.", false],
    cache_permission: ["MFLUX cannot access required files. Check model cache and temporary directory permissions on the Luvox host.", false],
    dependencies: ["MFLUX or a required Python dependency could not load. Repair or update the MFLUX installation on the Luvox host.", false],
    download: ["Required model resources could not be downloaded. Check Hugging Face access and the host's network and cache, then try again.", true],
  };
  const failure = Object.hasOwn(failures, code) ? failures[code] : undefined;
  return failure
    ? new LocalMfluxError(failure[0], 503, `local_mflux_${code}_error`, failure[1])
    : new LocalMfluxError("MFLUX generation failed.", 500, "local_mflux_error", false);
}

async function createMfluxDirectory(binary: string, kind: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), MFLUX_TEMP_PREFIX));
  activeDirectories.add(directory);
  try {
    await chmod(directory, 0o700);
    const owner = `${JSON.stringify({ kind, version: 1, pid: process.pid, binary })}\n`;
    if (Buffer.byteLength(owner) > MFLUX_OWNER_MAX_BYTES) {
      throw new LocalMfluxError("The configured MFLUX executable path is too long.", 503, "local_mflux_configuration_error", false);
    }
    await writeFile(path.join(directory, MFLUX_OWNER_FILE), owner, { flag: "wx", mode: 0o600 });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    activeDirectories.delete(directory);
    throw error;
  }
}

async function mfluxPython(binary: string, pipeline: string): Promise<string | undefined> {
  // Standard pip/uv entry points name their own interpreter. Custom wrappers keep using the CLI.
  const file = await open(binary, "r").catch(() => undefined);
  if (!file) return undefined;
  try {
    const buffer = Buffer.alloc(4_096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) return undefined;
    const source = buffer.toString("utf8", 0, bytesRead).replaceAll("\r\n", "\n");
    const header = /^#!(\/[^\n]+\/python(?:\d+(?:\.\d+)*)?)\n(?:# -\*- coding: utf-8 -\*-\n)?(?:import re\n)?import sys\nfrom (mflux\.[\w.]+) import main\nif __name__ == ["']__main__["']:\n/.exec(source);
    if (!header) return undefined;
    const module = pipeline === "flux2-edit" ? "mflux.models.flux2.cli.flux2_edit_generate" : "mflux.models.flux2.cli.flux2_generate";
    const body = source.slice(header[0].length).trimEnd().replaceAll("'", '"');
    if (header[2] !== module || ![
      "    sys.exit(main())",
      '    sys.argv[0] = re.sub(r"(-script\\.pyw|\\.exe)?$", "", sys.argv[0])\n    sys.exit(main())',
      '    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())',
    ].includes(body)) return undefined;
    accessSync(header[1], fsConstants.X_OK);
    return header[1];
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

async function stopWarmWorker(): Promise<void> {
  const worker = warmWorker;
  if (!worker) return;
  worker.key = "";
  clearTimeout(worker.idleTimer);
  signalChild(worker.child, "SIGTERM");
  const killTimer = setTimeout(() => signalChild(worker.child, "SIGKILL"), 5_000);
  killTimer.unref();
  await worker.closed;
  clearTimeout(killTimer);
}

async function startWarmWorker(python: string, binary: string, pipeline: string, key: string, oneShot: boolean): Promise<NonNullable<typeof warmWorker>> {
  const directory = await createMfluxDirectory(python, MFLUX_WORKER_KIND);
  try {
    const script = path.join(directory, "worker.py");
    await writeFile(script, MFLUX_WORKER_SOURCE, { mode: 0o600 });
    assertMfluxMayContinue();
    const child = spawn(python, ["-u", "-B", script, binary, pipeline, String(process.pid), ...(oneShot ? ["--once"] : [])], {
      cwd: directory,
      detached: true,
      env: childEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: NonNullable<typeof warmWorker> = {
      child,
      key,
      closed: new Promise<void>((resolve) => {
        child.once("close", () => {
          worker.key = "";
          clearTimeout(worker.idleTimer);
          void rm(directory, { recursive: true, force: true }).then(() => {
            activeDirectories.delete(directory);
          }).catch(() => {
            storageBlocked = true;
          }).finally(() => {
            if (warmWorker === worker) warmWorker = undefined;
            resolve();
          });
        });
      }),
    };
    // Errors also cause close; never leave an idle pipe error unhandled.
    child.on("error", () => {});
    child.once("exit", () => { worker.key = ""; });
    child.stdin?.on("error", () => signalChild(child, "SIGKILL"));
    warmWorker = worker;
    return worker;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    activeDirectories.delete(directory);
    throw error;
  }
}

async function runMflux(
  binary: string,
  args: string[],
  directory: string,
  input: LocalMfluxGenerateImageInput,
  signal?: AbortSignal,
  onProgress?: (progress: LocalMfluxProgress) => void,
): Promise<void> {
  const keepAlive = input.lowRam ? 0 : keepAliveMilliseconds();
  const pipeline = input.inputReference ? "flux2-edit" : "flux2";
  const python = await mfluxPython(binary, pipeline);
  const key = JSON.stringify([binary, pipeline, input.model, input.quantization, input.vaeTiling ? input.vaeTileSize : null]);
  if (warmWorker && (!keepAlive || !python || warmWorker.key !== key)) await stopWarmWorker();
  assertMfluxMayContinue(signal);
  const worker = python ? warmWorker ?? await startWarmWorker(python, binary, pipeline, key, !keepAlive) : undefined;
  if (worker) clearTimeout(worker.idleTimer);
  if (signal?.aborted) {
    await stopWarmWorker();
    assertMfluxMayContinue(signal);
  }
  const totalSteps = input.steps;
  return new Promise((resolve, reject) => {
    let generationRemaining = timeoutMilliseconds();
    let downloadRemaining = timeoutMilliseconds("MFLUX_DOWNLOAD_TIMEOUT_MINUTES", 120);
    const child = worker?.child ?? spawn(binary, args, {
      cwd: directory,
      detached: true,
      env: childEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    let settled = false;
    let stopError: LocalMfluxError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let progressBuffer = "";
    let controlBuffer = "";
    let lastStep = -1;
    let completed = false;
    let resourcePhase = false;
    let phaseStarted = performance.now();
    let timeout: ReturnType<typeof setTimeout>;
    let reportedError: LocalMfluxError | undefined;

    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        stop(new LocalMfluxError(
          resourcePhase
            ? "Model resource download timed out. Try again to reuse cached files, or increase MFLUX_DOWNLOAD_TIMEOUT_MINUTES."
            : "MFLUX loading or generation timed out.",
          504,
          resourcePhase ? "local_mflux_download_timeout" : "local_mflux_timeout",
          true,
        ));
      }, Math.max(0, resourcePhase ? downloadRemaining : generationRemaining));
      timeout.unref();
    };
    const setResourcePhase = (next: boolean) => {
      if (next === resourcePhase) return;
      const elapsed = performance.now() - phaseStarted;
      if (resourcePhase) downloadRemaining -= elapsed;
      else generationRemaining -= elapsed;
      resourcePhase = next;
      phaseStarted = performance.now();
      armTimeout();
    };
    const resourceProgress = (phase: "checking" | "downloading" | "loading", download?: LocalMfluxProgress["download"]) => {
      setResourcePhase(phase !== "loading");
      onProgress?.({
        phase, step: 0, total: totalSteps,
        percent: download && download.total > 0 ? Math.min(100, 100 * download.completed / download.total) : 0,
        download,
      });
    };

    const appendDiagnostics = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const lines = (progressBuffer + text).split(/[\r\n]/);
      progressBuffer = (lines.pop() || "").slice(-4_096);
      for (const raw of lines) {
        const line = raw.slice(-4_096).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        if (!worker) {
          // Custom wrappers retain their CLI. Recognize native Hub output without exposing raw logs.
          if (/GatedRepoError|LocalTokenNotFoundError|\b(?:401|403) Client Error/.test(line)) reportedError = mfluxEngineError("access");
          else if (/No space left on device|\bENOSPC\b/.test(line)) reportedError = mfluxEngineError("disk_full");
          else if (/PermissionError|Read-only file system/.test(line)) reportedError = mfluxEngineError("cache_permission");
          else if (/ModuleNotFoundError|ImportError/.test(line)) reportedError = mfluxEngineError("dependencies");
          else if (/ConnectError|ConnectionError|ReadTimeout|LocalEntryNotFoundError/.test(line)) reportedError = mfluxEngineError("network");
          if (/Downloading model from HuggingFace:|^\s*Fetching \d+ files:/.test(line)) {
            const files = /\|\s*(\d+)\/(\d+)\s*\[/.exec(line);
            resourceProgress("downloading", files ? { completed: Number(files[1]), total: Number(files[2]), unit: "files" } : undefined);
            if (files && Number(files[2]) > 0 && files[1] === files[2]) resourceProgress("loading");
            continue;
          }
          if (resourcePhase && /Download complete|Reconstruction complete/.test(line)) {
            resourceProgress("loading");
            continue;
          }
        }
        // Inference bars have no filename/Fetching prefix; download counts must not masquerade as steps.
        const match = /^\s*(\d{1,3})%\|[^\r\n]*\|\s*(\d+)\/(\d+)\s*\[([^\]]+)\]/.exec(line);
        if (!match) continue;
        const step = Number(match[2]);
        const total = Number(match[3]);
        if (total !== totalSteps || step <= lastStep || step > total) continue;
        setResourcePhase(false);
        reportedError = undefined;
        const timing = /^(\d+(?::\d+){1,2})<([\d:?]+)(?:,\s*([\d.]+)(s\/it|it\/s))?/.exec(match[4]);
        const rate = Number(timing?.[3]);
        lastStep = step;
        onProgress?.({
          phase: step === total ? "decoding" : "generating",
          step,
          total,
          percent: Math.min(100, Math.max(0, Number(match[1]))),
          etaSeconds: timing?.[2] === "?" ? undefined : parseClock(timing?.[2] || ""),
          secondsPerStep: Number.isFinite(rate) && rate > 0 ? timing?.[4] === "it/s" ? 1 / rate : rate : undefined,
        });
      }
    };
    const finish = (error?: LocalMfluxError) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      stopActive = undefined;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout?.off("data", worker ? appendControl : appendDiagnostics);
      child.stderr?.off("data", appendDiagnostics);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else {
        if (worker && keepAlive) {
          worker.idleTimer = setTimeout(() => { void stopWarmWorker(); }, keepAlive);
          worker.idleTimer.unref();
        }
        resolve();
      }
    };
    const appendControl = (chunk: Buffer) => {
      if (stopError) return;
      const lines = (controlBuffer + chunk.toString("utf8")).split("\n");
      controlBuffer = lines.pop() || "";
      if (controlBuffer.length > 4_096) {
        controlBuffer = "";
        stop(mfluxEngineError("engine"));
        return;
      }
      for (const line of lines) {
        if (settled || stopError) break;
        try {
          if (line.length > 4_096) throw new Error("oversized event");
          const event = JSON.parse(line);
          if (event.type === "done") {
            completed = true;
            if (keepAlive) finish();
          } else if (event.type === "error" && typeof event.code === "string") {
            stop(mfluxEngineError(event.code));
          } else if (event.type === "checking" || event.type === "loading") {
            resourceProgress(event.type);
          } else if (
            event.type === "downloading" &&
            Number.isSafeInteger(event.completed) && event.completed >= 0 &&
            Number.isSafeInteger(event.total) && event.total >= event.completed &&
            (event.unit === "bytes" || event.unit === "files")
          ) {
            resourceProgress("downloading", { completed: event.completed, total: event.total, unit: event.unit });
          } else throw new Error("invalid event");
        } catch {
          stop(mfluxEngineError("engine"));
        }
      }
    };
    child.stdout?.on("data", worker ? appendControl : appendDiagnostics);
    child.stderr?.on("data", appendDiagnostics);

    const stop = (error: LocalMfluxError) => {
      if (stopError) return;
      stopError = error;
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => signalChild(child, "SIGKILL"), 5_000);
      killTimer.unref();
    };
    const abort = () => stop(new LocalMfluxError("MFLUX generation was stopped.", 499, "local_mflux_aborted", false));
    stopActive = abort;
    signal?.addEventListener("abort", abort, { once: true });

    armTimeout();

    const onError = () => {
      stopError ??= new LocalMfluxError("MFLUX could not start.", 503, "local_mflux_spawn_error", false);
    };
    const onClose = async (code: number | null) => {
      if (worker) await worker.closed;
      finish(stopError ?? (code === 0 && (!worker || completed) ? undefined
        : reportedError ?? mfluxEngineError(resourcePhase && lastStep < 0 ? "download" : "engine")));
    };
    child.once("error", onError);
    child.once("close", onClose);
    if (worker) child.stdin!.write(`${JSON.stringify(args)}\n`);
  });
}

export async function generateLocalMfluxImage(
  input: LocalMfluxGenerateImageInput,
  signal?: AbortSignal,
  onProgress?: (progress: LocalMfluxProgress) => void,
): Promise<ImageGenerationResponse> {
  if (!isLocalMfluxSupported()) {
    throw new LocalMfluxError(
      "Local MFLUX generation requires macOS on Apple Silicon.",
      503,
      "local_mflux_unsupported",
      false,
    );
  }
  if (storageBlocked) {
    throw new LocalMfluxError(
      "Local MFLUX storage is still owned by another process.",
      503,
      "local_mflux_unavailable",
      true,
    );
  }
  // ponytail: generations are created only from route-validated static presets.
  const model = getMfluxImageModel(input.model)!;
  const resolution = getMfluxImageResolution(input.resolution)!;
  const executable = input.inputReference
    ? model.referenceExecutable
    : model.executable;
  const binary = resolveMfluxBinary(model, executable);
  if (!binary) {
    throw new LocalMfluxError(
      executable === model.executable
        ? `Install ${executable} or set ${model.environmentVariable} to its absolute path.`
        : `Install ${executable} beside ${model.executable} or on the server PATH.`,
      503,
      "local_mflux_configuration_error",
      false,
    );
  }
  if (shuttingDown) {
    throw new LocalMfluxError("The local MFLUX service is shutting down.", 503, "local_mflux_unavailable", true);
  }
  if (generationReserved) {
    throw new LocalMfluxError("Another local MFLUX generation is active.", 409, "local_mflux_busy", true);
  }
  const operationSignal = signal
    ? AbortSignal.any([signal, shutdownController.signal])
    : shutdownController.signal;
  assertMfluxMayContinue(operationSignal);
  onProgress?.({ phase: "loading", step: 0, total: input.steps, percent: 0 });

  generationReserved = true;
  let finishCompletion: (() => void) | undefined;
  activeCompletion = new Promise((resolve) => {
    finishCompletion = resolve;
  });
  let directory: string | undefined;
  try {
    directory = await createMfluxDirectory(binary, MFLUX_OWNER_KIND);
    const promptPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "output.png");
    let prompt = input.prompt;
    const args = [
      "--model", input.model,
      "--prompt-file", promptPath,
      "--output", outputPath,
      "--steps", String(input.steps),
      "--width", String(resolution.width),
      "--height", String(resolution.height),
    ];
    if (input.quantization !== null) args.push("--quantize", String(input.quantization));
    if (input.seed !== undefined) args.push("--seed", String(input.seed));
    if (input.lowRam) args.push("--low-ram");
    if (input.vaeTiling || input.lowRam) args.push("--vae-tiling", "--vae-tile-size", String(input.vaeTileSize));
    if (input.inputReference) {
      const [header, base64] = input.inputReference.split(",", 2);
      const extension = header === "data:image/jpeg;base64" ? "jpg" : header === "data:image/webp;base64" ? "webp" : "png";
      const referencePath = path.join(directory, `reference.${extension}`);
      await writeFile(referencePath, Buffer.from(base64, "base64"), { mode: 0o600, signal: operationSignal });
      try {
        const reference = await frameReferenceImage(
          referencePath,
          directory,
          resolution,
          input.referenceFit,
          Boolean(input.generateMissing),
          operationSignal,
        );
        args.push("--image-paths", reference.path);
        if (input.generateMissing && (reference.width < resolution.width || reference.height < resolution.height)) {
          const sides = [reference.width < resolution.width ? "left and right" : "", reference.height < resolution.height ? "top and bottom" : ""].filter(Boolean).join(" and ");
          prompt += `\n\nCanvas extension: Generate a full-bleed ${resolution.width}x${resolution.height} image. Keep the entire reference composition centered and uncropped, without stretching it. Extend the surrounding scene naturally on the ${sides} to fill the extra canvas, matching lighting, perspective, colors, and textures. Apply the requested edits and generate scene content instead of black bars, blank margins, borders, or letterboxing.`;
        }
      } finally {
        await rm(referencePath, { force: true });
      }
    }

    await writeFile(promptPath, prompt, { mode: 0o600, signal: operationSignal });
    assertMfluxMayContinue(operationSignal);
    await runMflux(
      binary,
      args,
      directory,
      input,
      operationSignal,
      onProgress,
    );
    let outputStats;
    try {
      outputStats = await stat(outputPath);
    } catch {
      throw new LocalMfluxError("MFLUX did not create an image file.", 502, "local_mflux_output_error", false);
    }
    if (!outputStats.isFile() || outputStats.size < 1 || outputStats.size > MAX_OUTPUT_BYTES) {
      throw new LocalMfluxError("MFLUX did not create a valid image file.", 502, "local_mflux_output_error", false);
    }
    await inspectRaster(outputPath, "The MFLUX output", resolution, operationSignal);
    assertMfluxMayContinue(operationSignal);
    const output = await readFile(outputPath);
    const mediaType = rasterMediaType(output);
    if (!mediaType) {
      throw new LocalMfluxError("MFLUX created an unsupported image format.", 502, "local_mflux_output_error", false);
    }
    return { b64Json: output.toString("base64"), mediaType };
  } catch (error) {
    await stopWarmWorker();
    if (operationSignal.aborted) assertMfluxMayContinue(operationSignal);
    throw error;
  } finally {
    try {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
        activeDirectories.delete(directory);
      }
    } finally {
      generationReserved = false;
      finishCompletion?.();
      activeCompletion = undefined;
    }
  }
}

export function beginLocalMfluxShutdown(): void {
  shuttingDown = true;
  shutdownController.abort();
  stopActive?.();
  void stopWarmWorker();
}

export async function shutdownLocalMflux(): Promise<void> {
  beginLocalMfluxShutdown();
  await activeCompletion;
  await stopWarmWorker();
}

process.once("exit", () => {
  shutdownController.abort();
  if (activeChild) signalChild(activeChild, "SIGKILL");
  if (warmWorker) signalChild(warmWorker.child, "SIGKILL");
  for (const directory of activeDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Startup cleanup retries owner-marked directories after an abrupt exit.
    }
  }
});
