import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
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

async function resolveRuntime(): Promise<LocalH3Runtime> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new LocalH3Error(
      "Local h3.c generation requires macOS on Apple Silicon and is not available inside the Docker container.",
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
  if (queue.length >= MAX_QUEUED_JOBS) {
    throw new LocalH3Error(
      "The local h3.c queue is full. Wait for an existing generation to finish.",
      429,
      "local_queue_full",
      true,
    );
  }

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

  const job: LocalJob = {
    id,
    input,
    runtime,
    directory,
    temporaryOutput: path.join(directory, "result.tmp.mp4"),
    output: path.join(directory, "result.mp4"),
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
