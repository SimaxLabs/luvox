import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, accessSync, rmSync, statSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getMfluxImageModel, getMfluxImageResolution, MFLUX_IMAGE_MODELS } from "../shared/imageModels.js";
import type { ImageGenerationResponse, LocalMfluxProgress } from "../shared/imageTypes.js";
import type { LocalH3FrameFitId } from "../shared/localH3.js";
import type { LocalMfluxGenerateImageInput } from "./validation.js";
import { rasterMediaType } from "./validation.js";

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCE_PIXELS = 4_096 * 4_096;
const MAX_REFERENCE_ASPECT_RATIO = 16;
const MFLUX_TEMP_PREFIX = "luvox-mflux-";
const MFLUX_OWNER_FILE = ".luvox-owned";
const MFLUX_OWNER_KIND = "luvox-mflux-request";
const MFLUX_OWNER_MAX_BYTES = 4_096;
const execFileAsync = promisify(execFile);
const activeDirectories = new Set<string>();
const shutdownController = new AbortController();
let activeChild: ChildProcess | undefined;
let activeExecution: Promise<void> | undefined;
let activeCompletion: Promise<void> | undefined;
let generationReserved = false;
let stopActive: (() => void) | undefined;
let shuttingDown = false;
let storageBlocked = false;

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

export function isLocalMfluxConfigured(): boolean {
  return getAvailableLocalMfluxModels().length > 0;
}

export function getAvailableLocalMfluxModels(): string[] {
  if (!isLocalMfluxSupported() || storageBlocked) return [];
  try {
    timeoutMilliseconds();
  } catch {
    return [];
  }
  return MFLUX_IMAGE_MODELS.filter((model) => resolveMfluxBinary(model)).map((model) => model.id);
}

function timeoutMilliseconds(): number {
  const minutes = Number(process.env.MFLUX_TIMEOUT_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
    throw new LocalMfluxError(
      "MFLUX_TIMEOUT_MINUTES must be between 1 and 240.",
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
): Promise<boolean> {
  if (!binary) return false;
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pgid=,command="],
    { encoding: "utf8", env: childEnvironment(), maxBuffer: 1024 * 1024, timeout: 5_000 },
  );
  const promptPath = path.join(directory, "prompt.txt");
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
        owner.kind !== MFLUX_OWNER_KIND ||
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
      if (!await stopOwnedProcessGroup(candidate, typeof owner.binary === "string" ? owner.binary : undefined)) {
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
  signal?: AbortSignal,
): Promise<string> {
  const sourceSize = await inspectRaster(source, "The reference image", undefined, signal, false);
  const scale = fit === "cover"
    ? Math.max(target.width / sourceSize.width, target.height / sourceSize.height)
    : Math.min(target.width / sourceSize.width, target.height / sourceSize.height);
  const round = fit === "cover" ? Math.ceil : Math.floor;
  const scaledWidth = Math.max(1, round(sourceSize.width * scale));
  const scaledHeight = Math.max(1, round(sourceSize.height * scale));
  const output = path.join(directory, "reference-framed.png");
  const framingArgs = fit === "cover"
    ? ["--cropToHeightWidth", String(target.height), String(target.width)]
    : ["--padToHeightWidth", String(target.height), String(target.width), "--padColor", "000000"];
  try {
    await execFileAsync(
      "/usr/bin/sips",
      [
        "--resampleHeightWidth", String(scaledHeight), String(scaledWidth),
        ...framingArgs,
        source,
        "--out", output,
      ],
      { encoding: "utf8", env: childEnvironment(), killSignal: "SIGKILL", maxBuffer: 8_192, signal, timeout: 30_000 },
    );
  } catch {
    assertMfluxMayContinue(signal);
    throw new LocalMfluxError(
      "The reference image could not be framed for the selected resolution.",
      400,
      "local_mflux_image_error",
      false,
    );
  }
  const outputSize = await inspectRaster(output, "The framed reference image", undefined, signal);
  if (outputSize.width !== target.width || outputSize.height !== target.height) {
    throw new LocalMfluxError(
      "The reference image could not be framed for the selected resolution.",
      400,
      "local_mflux_image_error",
      false,
    );
  }
  return output;
}

function parseClock(value: string): number | undefined {
  if (!/^\d+(?::\d+){1,2}$/.test(value)) return undefined;
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function runMflux(
  binary: string,
  args: string[],
  directory: string,
  totalSteps: number,
  signal?: AbortSignal,
  onProgress?: (progress: LocalMfluxProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LocalMfluxError("MFLUX generation was stopped.", 499, "local_mflux_aborted", false));
      return;
    }

    const timeoutMs = timeoutMilliseconds();
    const child = spawn(binary, args, {
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
    let lastStep = -1;

    const appendDiagnostics = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      progressBuffer = (progressBuffer + text).slice(-4_096);
      for (const match of progressBuffer.matchAll(/(\d{1,3})%\|[^\r\n]*\|\s*(\d+)\/(\d+)\s*\[([^\]]+)\]/g)) {
        const step = Number(match[2]);
        const total = Number(match[3]);
        if (total !== totalSteps || step <= lastStep || step > total) continue;
        const timing = /^(\d+(?::\d+){1,2})<([\d:?]+)(?:,\s*([\d.]+)(s\/it|it\/s))?/.exec(match[4]);
        const rate = Number(timing?.[3]);
        lastStep = step;
        onProgress?.({
          phase: step === total ? "decoding" : "generating",
          step,
          total,
          percent: Math.min(100, Math.max(0, Number(match[1]))),
          stepElapsedSeconds: timing ? parseClock(timing[1]) : undefined,
          etaSeconds: timing?.[2] === "?" ? undefined : parseClock(timing?.[2] || ""),
          secondsPerStep: Number.isFinite(rate) && rate > 0 ? timing?.[4] === "it/s" ? 1 / rate : rate : undefined,
        });
      }
    };
    child.stdout?.on("data", appendDiagnostics);
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

    const timeout = setTimeout(() => {
      stop(new LocalMfluxError("MFLUX generation timed out.", 504, "local_mflux_timeout", true));
    }, timeoutMs);
    timeout.unref();

    child.once("error", () => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      stopActive = undefined;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      reject(new LocalMfluxError("MFLUX could not start.", 503, "local_mflux_spawn_error", false));
    });
    child.once("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      stopActive = undefined;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (stopError) reject(stopError);
      else if (code === 0) resolve();
      else reject(new LocalMfluxError("MFLUX generation failed.", 500, "local_mflux_error", false));
    });
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
  const model = getMfluxImageModel(input.model);
  if (!model) {
    throw new LocalMfluxError("Unsupported MFLUX model.", 400, "local_mflux_model_error", false);
  }
  if (model.requiresReference && !input.inputReference) {
    throw new LocalMfluxError("Qwen Image Edit requires a reference image.", 400, "local_mflux_image_error", false);
  }
  const executable = input.inputReference && "referenceExecutable" in model
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
  const resolution = getMfluxImageResolution(input.resolution);
  if (!resolution) {
    throw new LocalMfluxError("Unsupported MFLUX resolution preset.", 400, "local_mflux_resolution_error", false);
  }
  onProgress?.({ phase: "loading", step: 0, total: input.steps, percent: 0 });

  generationReserved = true;
  let finishCompletion: (() => void) | undefined;
  activeCompletion = new Promise((resolve) => {
    finishCompletion = resolve;
  });
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), MFLUX_TEMP_PREFIX));
    activeDirectories.add(directory);
    await chmod(directory, 0o700);
    const owner = `${JSON.stringify({ kind: MFLUX_OWNER_KIND, version: 1, pid: process.pid, binary })}\n`;
    if (Buffer.byteLength(owner) > MFLUX_OWNER_MAX_BYTES) {
      throw new LocalMfluxError("The configured MFLUX executable path is too long.", 503, "local_mflux_configuration_error", false);
    }
    await writeFile(
      path.join(directory, MFLUX_OWNER_FILE),
      owner,
      { flag: "wx", mode: 0o600, signal: operationSignal },
    );
    const promptPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "output.png");
    await writeFile(promptPath, input.prompt, { mode: 0o600, signal: operationSignal });
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
    if (model.id === "qwen-image-edit" && input.guidance !== undefined) args.push("--guidance", String(input.guidance));
    if (input.lowRam) args.push("--low-ram");
    if (input.vaeTiling || input.lowRam) args.push("--vae-tiling", "--vae-tile-size", String(input.vaeTileSize));
    if (input.inputReference) {
      const [header, base64] = input.inputReference.split(",", 2);
      const extension = header === "data:image/jpeg;base64" ? "jpg" : header === "data:image/webp;base64" ? "webp" : "png";
      const referencePath = path.join(directory, `reference.${extension}`);
      await writeFile(referencePath, Buffer.from(base64, "base64"), { mode: 0o600, signal: operationSignal });
      try {
        args.push("--image-paths", await frameReferenceImage(
          referencePath,
          directory,
          resolution,
          input.referenceFit,
          operationSignal,
        ));
      } finally {
        await rm(referencePath, { force: true });
      }
    }

    assertMfluxMayContinue(operationSignal);
    activeExecution = runMflux(
      binary,
      args,
      directory,
      input.steps,
      operationSignal,
      onProgress,
    );
    await activeExecution;
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
    const mediaType = rasterMediaType(output.subarray(0, 24).toString("base64"));
    if (!mediaType) {
      throw new LocalMfluxError("MFLUX created an unsupported image format.", 502, "local_mflux_output_error", false);
    }
    return { b64Json: output.toString("base64"), mediaType };
  } catch (error) {
    if (operationSignal.aborted) assertMfluxMayContinue(operationSignal);
    throw error;
  } finally {
    activeExecution = undefined;
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
}

export async function shutdownLocalMflux(): Promise<void> {
  beginLocalMfluxShutdown();
  await activeCompletion;
}

process.once("exit", () => {
  shutdownController.abort();
  if (activeChild) signalChild(activeChild, "SIGKILL");
  for (const directory of activeDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Startup cleanup retries owner-marked directories after an abrupt exit.
    }
  }
});
