import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, accessSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getMfluxImageModel, getMfluxImageResolution, MFLUX_IMAGE_MODELS } from "../shared/imageModels.js";
import type { ImageGenerationResponse, LocalMfluxProgress } from "../shared/imageTypes.js";
import type { LocalMfluxGenerateImageInput } from "./validation.js";
import { rasterMediaType } from "./validation.js";

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 16_000;
const MAX_REFERENCE_PIXELS = 50_000_000;
const MAX_REFERENCE_ASPECT_RATIO = 16;
const execFileAsync = promisify(execFile);
let activeChild: ChildProcess | undefined;
let activeExecution: Promise<void> | undefined;
let activeCompletion: Promise<void> | undefined;
let generationReserved = false;
let stopActive: (() => void) | undefined;
let shuttingDown = false;

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
  if (!isLocalMfluxSupported()) return [];
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

async function inspectRaster(file: string, label: string, expectedSize?: { width: number; height: number }): Promise<void> {
  const errorStatus = expectedSize ? 502 : 400;
  const errorType = expectedSize ? "local_mflux_output_error" : "local_mflux_image_error";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", file],
      { encoding: "utf8", env: childEnvironment(), maxBuffer: 8_192, timeout: 15_000 },
    ));
  } catch {
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

  const probe = `${file}.probe.png`;
  try {
    await execFileAsync(
      "/usr/bin/sips",
      ["-s", "format", "png", file, "--out", probe],
      { encoding: "utf8", env: childEnvironment(), maxBuffer: 8_192, timeout: 30_000 },
    );
    const probeStats = await stat(probe);
    if (!probeStats.isFile() || probeStats.size < 1) throw new Error("empty probe");
  } catch {
    throw new LocalMfluxError(`${label} is not a decodable raster image.`, errorStatus, errorType, false);
  } finally {
    await rm(probe, { force: true });
  }
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
    let diagnostics = "";
    let settled = false;
    let stopError: LocalMfluxError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let progressBuffer = "";
    let lastStep = -1;

    const appendDiagnostics = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      diagnostics = (diagnostics + text).slice(-MAX_DIAGNOSTIC_CHARS);
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

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      stopActive = undefined;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      reject(new LocalMfluxError(`MFLUX could not start: ${error.message}`, 503, "local_mflux_spawn_error", false));
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
      else {
        const detail = diagnostics.trim();
        reject(new LocalMfluxError(
          detail ? `MFLUX generation failed: ${detail}` : "MFLUX generation failed.",
          500,
          "local_mflux_error",
          false,
        ));
      }
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
    directory = await mkdtemp(path.join(os.tmpdir(), "motio-mflux-"));
    await chmod(directory, 0o700);
    const promptPath = path.join(directory, "prompt.txt");
    const outputPath = path.join(directory, "output.png");
    await writeFile(promptPath, input.prompt, { mode: 0o600 });
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
      await writeFile(referencePath, Buffer.from(base64, "base64"), { mode: 0o600 });
      await inspectRaster(referencePath, "The reference image");
      args.push("--image-paths", referencePath);
    }

    if (shuttingDown || signal?.aborted) {
      throw new LocalMfluxError("MFLUX generation was stopped.", 499, "local_mflux_aborted", false);
    }
    activeExecution = runMflux(binary, args, directory, input.steps, signal, onProgress);
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
    await inspectRaster(outputPath, "The MFLUX output", resolution);
    const output = await readFile(outputPath);
    const mediaType = rasterMediaType(output.subarray(0, 24).toString("base64"));
    if (!mediaType) {
      throw new LocalMfluxError("MFLUX created an unsupported image format.", 502, "local_mflux_output_error", false);
    }
    return { b64Json: output.toString("base64"), mediaType };
  } finally {
    activeExecution = undefined;
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      generationReserved = false;
      finishCompletion?.();
      activeCompletion = undefined;
    }
  }
}

export function beginLocalMfluxShutdown(): void {
  shuttingDown = true;
  stopActive?.();
}

export async function shutdownLocalMflux(): Promise<void> {
  beginLocalMfluxShutdown();
  await activeCompletion;
}

process.once("exit", () => {
  if (activeChild) signalChild(activeChild, "SIGKILL");
});
