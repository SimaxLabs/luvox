import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getLocalH3QualityPreset,
  getLocalH3Resolution,
} from "../shared/localH3.js";
import type { LocalGenerateVideoInput } from "./validation.js";
import type { VideoStatusResponse } from "./videoTypes.js";

const LOCAL_JOB_PREFIX = "local_";
const MAX_DIAGNOSTIC_CHARS = 16_000;
const MAX_PROGRESS_CARRY_CHARS = 4_096;
const MAX_QUEUED_JOBS = 3;
const MAX_RETAINED_JOBS = 20;
const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_RETAINED_REFERENCE_IMAGES = 20;
const REFERENCE_IMAGE_TTL_MS = 24 * 60 * 60_000;
const REFERENCE_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

interface LocalH3Runtime {
  binary: string;
  modelDirectory: string;
  runtimeDirectory: string;
  jobsDirectory: string;
}

interface LocalJob {
  id: string;
  input: LocalGenerateVideoInput;
  runtime: LocalH3Runtime;
  directory: string;
  temporaryOutput: string;
  output: string;
  firstFrame?: string;
  lastFrame?: string;
  status: "queued" | "processing" | "completed" | "failed";
  phase: string;
  progress: number;
  error?: string;
  diagnostics: string;
  progressCarry: string;
  createdAt: number;
}

export class LocalH3Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocalH3Error";
  }
}

const jobs = new Map<string, LocalJob>();
const queue: string[] = [];
let activeJobId: string | undefined;
let activeChild: ChildProcess | undefined;
let pendingJobReservations = 0;
let referenceUploadTail: Promise<void> = Promise.resolve();

process.once("exit", () => activeChild?.kill("SIGTERM"));

function configuredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new LocalH3Error(
      `${name} is required for local h3.c generation.`,
      503,
      "local_configuration_error",
      false,
    );
  }
  if (!path.isAbsolute(value)) {
    throw new LocalH3Error(
      `${name} must be an absolute path.`,
      503,
      "local_configuration_error",
      false,
    );
  }
  return value;
}

function localProcessEnvironment(): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "H3_FFMPEG", "H3_FFPROBE"]) {
    if (process.env[name]) childEnvironment[name] = process.env[name];
  }
  return childEnvironment;
}

function jobTimeoutMs(): number {
  const minutes = Number(process.env.H3_TIMEOUT_MINUTES || 120);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1_440) return 120 * 60_000;
  return minutes * 60_000;
}

export function isLocalH3Supported(): boolean {
  const host = process.env.HOST?.trim() || "127.0.0.1";
  return (
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    ["127.0.0.1", "::1"].includes(host)
  );
}

async function resolveRuntime(): Promise<LocalH3Runtime> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new LocalH3Error(
      "Local h3.c generation requires macOS on Apple Silicon and is not available inside the Docker container.",
      503,
      "local_platform_error",
      false,
    );
  }
  if (!isLocalH3Supported()) {
    throw new LocalH3Error(
      "Local h3.c generation requires the server to bind only to 127.0.0.1 or ::1.",
      503,
      "local_platform_error",
      false,
    );
  }

  const binary = configuredPath("H3_BINARY");
  const modelDirectory = configuredPath("H3_MODEL_DIR");
  const configuredRuntimeDirectory = process.env.H3_RUNTIME_DIR?.trim();
  const configuredJobsDirectory = process.env.H3_JOBS_DIR?.trim();
  if (configuredRuntimeDirectory && !path.isAbsolute(configuredRuntimeDirectory)) {
    throw new LocalH3Error(
      "H3_RUNTIME_DIR must be an absolute path.",
      503,
      "local_configuration_error",
      false,
    );
  }
  if (configuredJobsDirectory && !path.isAbsolute(configuredJobsDirectory)) {
    throw new LocalH3Error(
      "H3_JOBS_DIR must be an absolute path.",
      503,
      "local_configuration_error",
      false,
    );
  }
  const runtimeDirectory = configuredRuntimeDirectory || path.dirname(binary);
  const jobsDirectory = configuredJobsDirectory || path.resolve(process.cwd(), ".h3-jobs");

  try {
    const binaryInfo = await stat(binary);
    if (!binaryInfo.isFile()) throw new Error("not a file");
    await access(binary, fsConstants.X_OK);
  } catch {
    throw new LocalH3Error(
      "H3_BINARY does not point to an executable h3.c binary.",
      503,
      "local_configuration_error",
      false,
    );
  }

  try {
    const modelInfo = await stat(modelDirectory);
    if (!modelInfo.isDirectory()) throw new Error("not a directory");
    await access(modelDirectory, fsConstants.R_OK);
  } catch {
    throw new LocalH3Error(
      "H3_MODEL_DIR is not readable.",
      503,
      "local_configuration_error",
      false,
    );
  }

  try {
    const shader = path.join(runtimeDirectory, "h3_shaders.metal");
    const shaderInfo = await stat(shader);
    if (!shaderInfo.isFile()) throw new Error("not a file");
    await access(shader, fsConstants.R_OK);
  } catch {
    throw new LocalH3Error(
      "h3_shaders.metal was not found in H3_RUNTIME_DIR or beside H3_BINARY.",
      503,
      "local_configuration_error",
      false,
    );
  }

  try {
    await mkdir(jobsDirectory, { recursive: true });
    const jobsInfo = await stat(jobsDirectory);
    if (!jobsInfo.isDirectory()) throw new Error("not a directory");
    await access(jobsDirectory, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new LocalH3Error(
      "H3_JOBS_DIR could not be created or is not writable.",
      503,
      "local_configuration_error",
      false,
    );
  }
  return { binary, modelDirectory, runtimeDirectory, jobsDirectory };
}

function referenceImageExtension(data: Buffer): string | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return ".png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return ".jpg";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return undefined;
}

async function probeReferenceImage(filePath: string): Promise<void> {
  const command = process.env.H3_FFMPEG?.trim() || "ffmpeg";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [
      "-v",
      "error",
      "-nostdin",
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ], {
      env: localProcessEnvironment(),
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (error?: LocalH3Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new LocalH3Error(
        "The reference image could not be decoded within 15 seconds.",
        400,
        "local_reference_error",
        false,
      ));
    }, 15_000);
    timeout.unref();

    child.once("error", () => finish(new LocalH3Error(
      "FFmpeg is required to validate local reference images.",
      503,
      "local_configuration_error",
      false,
    )));
    child.once("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new LocalH3Error(
        "Reference images must contain decodable PNG, JPEG, or WebP data.",
        400,
        "local_reference_error",
        false,
      ));
    });
  });
}

async function prepareReferenceDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new LocalH3Error(
      "The local reference-image staging path must be a real directory.",
      503,
      "local_configuration_error",
      false,
    );
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && REFERENCE_IMAGE_NAME.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const info = await stat(filePath).catch(() => undefined);
      return info ? { path: filePath, modifiedAt: info.mtimeMs } : undefined;
    }));
  const retained = files.filter((file): file is NonNullable<typeof file> => Boolean(file));
  const cutoff = Date.now() - REFERENCE_IMAGE_TTL_MS;
  const expired = retained.filter((file) => file.modifiedAt < cutoff);
  await Promise.all(expired.map((file) => rm(file.path, { force: true })));
  if (retained.length - expired.length >= MAX_RETAINED_REFERENCE_IMAGES) {
    throw new LocalH3Error(
      "The local reference-image staging area is full. Remove unused images or wait for staged images to expire.",
      429,
      "local_reference_limit",
      true,
    );
  }
}

async function storeLocalReferenceImage(data: Buffer): Promise<{ path: string }> {
  if (data.length < 1) {
    throw new LocalH3Error("Select a non-empty reference image.", 400, "local_reference_error", false);
  }
  if (data.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new LocalH3Error(
      "Reference images must be 25 MB or smaller.",
      413,
      "local_reference_error",
      false,
    );
  }

  const extension = referenceImageExtension(data);
  if (!extension) {
    throw new LocalH3Error(
      "Reference images must be PNG, JPEG, or WebP files.",
      415,
      "local_reference_error",
      false,
    );
  }

  const runtime = await resolveRuntime();
  const directory = path.join(runtime.jobsDirectory, "reference-images");
  await prepareReferenceDirectory(directory);
  const output = path.join(directory, `${randomUUID()}${extension}`);
  await writeFile(output, data, { flag: "wx", mode: 0o600 });
  try {
    await probeReferenceImage(output);
    return { path: output };
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function uploadLocalReferenceImage(data: Buffer): Promise<{ path: string }> {
  const operation = referenceUploadTail.then(() => storeLocalReferenceImage(data));
  referenceUploadTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function copyReferenceImage(source: string, directory: string, name: string): Promise<string> {
  let data: Buffer;
  try {
    const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size < 1 || file.size > MAX_REFERENCE_IMAGE_BYTES) {
        throw new Error("invalid reference image size");
      }
      data = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (bytesRead < 1) throw new Error("reference image changed while reading");
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  } catch {
    throw new LocalH3Error(
      "The reference image path must point to a readable file no larger than 25 MB.",
      400,
      "local_reference_error",
      false,
    );
  }

  const extension = referenceImageExtension(data);
  if (!extension) {
    throw new LocalH3Error(
      "Reference images must contain valid PNG, JPEG, or WebP data.",
      400,
      "local_reference_error",
      false,
    );
  }

  const output = path.join(directory, `${name}${extension}`);
  await writeFile(output, data, { flag: "wx", mode: 0o600 });
  await probeReferenceImage(output);
  return output;
}

function getJob(id: string): LocalJob {
  const job = jobs.get(id);
  if (!job) {
    throw new LocalH3Error(
      "The local generation job was not found. Local jobs are lost when the server restarts.",
      404,
      "local_job_not_found",
      false,
    );
  }
  return job;
}

function toResponse(job: LocalJob): VideoStatusResponse {
  const response: VideoStatusResponse = {
    id: job.id,
    provider: "local",
    status: job.status,
    phase: job.phase,
    progress: job.progress,
  };

  if (job.error) response.error = job.error;
  if (job.status === "completed") {
    const id = encodeURIComponent(job.id);
    response.videoUrl = `/api/video/content/${id}`;
    response.downloadUrl = `/api/video/content/${id}?download=1`;
  }
  return response;
}

function appendDiagnostics(job: LocalJob, text: string): void {
  job.diagnostics = `${job.diagnostics}${text}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

function parseProgressLine(job: LocalJob, line: string): void {
  const match = line.match(/^\s*(.+?)\s+(\d+)\/(\d+)(?:\s+.*)?$/);
  if (!match) return;

  const completed = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total < 1) return;

  job.phase = match[1].trim().slice(0, 80);
  job.progress = Math.min(99, Math.max(0, Math.round((completed / total) * 100)));
}

function consumeProgress(job: LocalJob, text: string): void {
  const parts = `${job.progressCarry}${text}`.split(/[\r\n]/);
  job.progressCarry = (parts.pop() || "").slice(-MAX_PROGRESS_CARRY_CHARS);
  for (const line of parts) parseProgressLine(job, line);
}

function failureDetails(job: LocalJob, code: number | null, signal: NodeJS.Signals | null): string {
  const detailLines = job.diagnostics
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^.+?\s+\d+\/\d+$/.test(line))
    .slice(-6);
  const exit = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const details = detailLines.join(" ").slice(-2_000);
  return details ? `h3.c failed with ${exit}: ${details}` : `h3.c failed with ${exit}.`;
}

async function executeJob(job: LocalJob): Promise<void> {
  const resolution = getLocalH3Resolution(job.input.resolution);
  const quality = getLocalH3QualityPreset(job.input.quality);
  if (!resolution || !quality) {
    job.status = "failed";
    job.error = "The selected local generation preset is no longer available.";
    return;
  }

  const args = [
    "-d",
    job.runtime.modelDirectory,
    "-p",
    job.input.prompt,
    "--width",
    String(resolution.width),
    "--height",
    String(resolution.height),
    "--frames",
    String(job.input.frames),
    "--steps",
    String(quality.steps),
    "--layers",
    String(quality.layers),
    "--reuse",
    String(quality.reuse),
    "--seed",
    String(job.input.seed),
  ];

  if (job.input.ssdStreaming) args.push("--ssd-streaming");
  if (job.firstFrame) args.push("--first-frame", job.firstFrame);
  if (job.lastFrame) args.push("--last-frame", job.lastFrame);
  args.push("-o", job.temporaryOutput);

  job.status = "processing";
  job.phase = "Starting h3.c";
  job.progress = 0;

  try {
    let timedOut = false;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const child = spawn(job.runtime.binary, args, {
          cwd: job.runtime.runtimeDirectory,
          env: localProcessEnvironment(),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        activeChild = child;
        let forceKill: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKill = setTimeout(() => child.kill("SIGKILL"), 10_000);
          forceKill.unref();
        }, jobTimeoutMs());
        timeout.unref();

        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendDiagnostics(job, text);
          consumeProgress(job, text);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendDiagnostics(job, text);
          consumeProgress(job, text);
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          activeChild = undefined;
          reject(error);
        });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          activeChild = undefined;
          resolve({ code, signal });
        });
      },
    );

    if (job.progressCarry) parseProgressLine(job, job.progressCarry);
    if (timedOut) {
      throw new Error(`h3.c exceeded the ${jobTimeoutMs() / 60_000}-minute generation timeout.`);
    }
    if (result.code !== 0) {
      throw new Error(failureDetails(job, result.code, result.signal));
    }

    job.phase = "Finalizing video";
    const output = await stat(job.temporaryOutput);
    if (!output.isFile() || output.size < 1) {
      throw new Error("h3.c exited successfully but did not create a video.");
    }

    await rename(job.temporaryOutput, job.output);
    job.status = "completed";
    job.phase = "Completed";
    job.progress = 100;
  } catch (error) {
    await rm(job.temporaryOutput, { force: true }).catch(() => undefined);
    job.status = "failed";
    job.phase = "Failed";
    job.error = error instanceof Error ? error.message : "Local h3.c generation failed.";
  }
}

function startNextJob(): void {
  if (activeJobId) return;
  const id = queue.shift();
  if (!id) return;

  const job = jobs.get(id);
  if (!job) {
    startNextJob();
    return;
  }

  activeJobId = id;
  void executeJob(job).finally(() => {
    activeJobId = undefined;
    startNextJob();
  });
}

export function isLocalJobId(id: string): boolean {
  return id.startsWith(LOCAL_JOB_PREFIX);
}

export async function generateLocalVideo(
  input: LocalGenerateVideoInput,
): Promise<VideoStatusResponse> {
  const runtime = await resolveRuntime();
  const firstFrameSource = input.firstFramePath;
  const lastFrameSource = input.lastFramePath;
  if (
    (firstFrameSource && !path.isAbsolute(firstFrameSource)) ||
    (lastFrameSource && !path.isAbsolute(lastFrameSource))
  ) {
    throw new LocalH3Error(
      "Reference image paths must be absolute.",
      400,
      "local_reference_error",
      false,
    );
  }
  if (queue.length + pendingJobReservations >= MAX_QUEUED_JOBS) {
    throw new LocalH3Error(
      "The local h3.c queue is full. Wait for an existing generation to finish.",
      429,
      "local_queue_full",
      true,
    );
  }
  pendingJobReservations += 1;

  try {
    const terminalJobs = [...jobs.values()]
      .filter((job) => job.status === "completed" || job.status === "failed")
      .sort((left, right) => left.createdAt - right.createdAt);
    while (jobs.size >= MAX_RETAINED_JOBS && terminalJobs.length > 0) {
      const expired = terminalJobs.shift();
      if (!expired) break;
      jobs.delete(expired.id);
      await rm(expired.directory, { recursive: true, force: true }).catch(() => undefined);
    }

    const id = `${LOCAL_JOB_PREFIX}${randomUUID()}`;
    const directory = path.join(runtime.jobsDirectory, id);
    await mkdir(directory, { recursive: false });

    let firstFrame: string | undefined;
    let lastFrame: string | undefined;
    try {
      if (firstFrameSource) {
        firstFrame = await copyReferenceImage(firstFrameSource, directory, "first-frame");
      }
      if (lastFrameSource) {
        lastFrame = await copyReferenceImage(lastFrameSource, directory, "last-frame");
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (error instanceof LocalH3Error) throw error;
      throw new LocalH3Error(
        "The server could not copy a reference image into the local job.",
        500,
        "local_storage_error",
        true,
      );
    }

    const job: LocalJob = {
      id,
      input,
      runtime,
      directory,
      temporaryOutput: path.join(directory, "result.tmp.mp4"),
      output: path.join(directory, "result.mp4"),
      firstFrame,
      lastFrame,
      status: "queued",
      phase: activeJobId ? "Waiting for local GPU" : "Queued",
      progress: 0,
      diagnostics: "",
      progressCarry: "",
      createdAt: Date.now(),
    };

    jobs.set(id, job);
    queue.push(id);
    startNextJob();
    return toResponse(job);
  } finally {
    pendingJobReservations -= 1;
  }
}

export function getLocalVideoStatus(id: string): VideoStatusResponse {
  return toResponse(getJob(id));
}

export async function getLocalVideoPath(id: string): Promise<string> {
  const job = getJob(id);
  if (job.status !== "completed") {
    throw new LocalH3Error(
      "The local video is not ready yet.",
      409,
      "local_video_not_ready",
      true,
    );
  }

  const output = await stat(job.output).catch(() => undefined);
  if (!output?.isFile()) {
    throw new LocalH3Error(
      "The completed local video file is missing.",
      404,
      "local_video_missing",
      false,
    );
  }
  return job.output;
}
