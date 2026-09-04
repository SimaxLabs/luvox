import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  getLocalH3AccelerationPreset,
  getLocalH3QualityPreset,
  getLocalH3Resolution,
  type LocalH3FrameFitId,
} from "../shared/localH3.js";
import type { LocalGenerateVideoInput } from "./validation.js";
import type { GenerationStatus, VideoStatusResponse } from "../shared/videoTypes.js";

const LOCAL_JOB_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL_MARKER = "terminal-status";
const STORAGE_LOCK = ".motio.lock";
const STORAGE_LOCK_OWNER = "owner.json";
const STORAGE_LOCK_TOMBSTONE = /^\.motio\.lock\.stale-\d+-\d+$/;
const STORAGE_OWNER = ".motio-owned";
const STORAGE_OWNER_CONTENT = "motio-h3-jobs-v1\n";
const MAX_DIAGNOSTIC_CHARS = 16_000;
const MAX_PROGRESS_CARRY_CHARS = 4_096;
const MAX_QUEUED_JOBS = 3;
const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_PIXELS = 50_000_000;
const MAX_REFERENCE_ASPECT_RATIO = 16;
const MAX_RETAINED_REFERENCE_IMAGES = 20;
const REFERENCE_IMAGE_TTL_MS = 24 * 60 * 60_000;
const REFERENCE_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

interface LocalH3Runtime {
  binary: string;
  modelDirectory: string;
  runtimeDirectory: string;
  jobsDirectory: string;
}

interface StorageLockOwner {
  pid: number;
  token: string;
  serverStartedAt?: string;
  activeGroups?: StorageProcessGroup[];
}

interface StorageProcessGroup {
  pid: number;
  startedAt: string;
  executable: string;
}

interface LocalJob {
  id: string;
  workspaceToken: string;
  input: LocalGenerateVideoInput;
  runtime: LocalH3Runtime;
  directory: string;
  temporaryOutput: string;
  output: string;
  firstFrame?: string;
  lastFrame?: string;
  status: GenerationStatus;
  phase: string;
  progress: number;
  error?: string;
  diagnostics: string;
  progressCarry: string;
  cancelRequested?: boolean;
  discardOnCompletion?: boolean;
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
const execFileAsync = promisify(execFile);
const queue: string[] = [];
let activeJobId: string | undefined;
let activeExecution: Promise<void> | undefined;
let stopActiveJob: (() => void) | undefined;
let pendingJobReservations = 0;
let referenceUploadTail: Promise<void> = Promise.resolve();
let referenceProcessingTail: Promise<void> = Promise.resolve();
const referenceUploads = new Map<string, { path: string; workspaceToken: string }>();
const discardedWorkspaces = new Set<string>();
const storageLockToken = randomUUID();
let storageLockPath: string | undefined;
let storageServerStartedAt: string | undefined;
let shuttingDown = false;
let storageReady = false;
let inFlightOperations = 0;
const idleResolvers = new Set<() => void>();
const childProcessGroups = new Set<number>();
const persistedProcessGroups = new Map<number, StorageProcessGroup>();

function trackChildProcess(child: ChildProcess): void {
  if (!child.pid) return;
  const group = child.pid;
  childProcessGroups.add(group);
  const remove = () => childProcessGroups.delete(group);
  child.once("error", remove);
  child.once("close", remove);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The process group may already be gone.
  }
}

async function activateProcessGroup(child: ChildProcess, expectedExecutable: string): Promise<void> {
  if (!child.pid) return;
  signalProcessGroup(child, "SIGSTOP");
  persistedProcessGroups.set(child.pid, {
    pid: child.pid,
    startedAt: "pending",
    executable: expectedExecutable,
  });
  try {
    writeStorageLockOwnerSync();
  } catch (error) {
    persistedProcessGroups.delete(child.pid);
    signalProcessGroup(child, "SIGKILL");
    throw error;
  }
  const identity = await readProcessIdentity(child.pid);
  if (!identity) {
    if (!processIsRunning(child.pid, true)) {
      persistedProcessGroups.delete(child.pid);
      writeStorageLockOwnerSync();
      return;
    }
    signalProcessGroup(child, "SIGKILL");
    throw new Error("The local child process identity could not be recorded safely.");
  }
  persistedProcessGroups.set(child.pid, {
    pid: child.pid,
    startedAt: identity.startedAt,
    executable: identity.executable,
  });
  try {
    writeStorageLockOwnerSync();
  } catch (error) {
    persistedProcessGroups.delete(child.pid);
    signalProcessGroup(child, "SIGKILL");
    throw error;
  }
  signalProcessGroup(child, "SIGCONT");
}

function deactivateProcessGroup(child: ChildProcess): void {
  if (!child.pid || !persistedProcessGroups.delete(child.pid)) return;
  writeStorageLockOwnerSync();
}

function signalChildProcessGroups(
  signal: NodeJS.Signals,
  groups: Iterable<number> = childProcessGroups,
): void {
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch {
      // The process may have exited between the tracked-set snapshot and this signal.
    }
  }
}

process.once("exit", () => signalChildProcessGroups("SIGTERM"));

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

async function readProcessIdentity(
  pid: number,
): Promise<{ executable: string; startedAt: string } | undefined> {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  try {
    const options = {
      encoding: "utf8" as const,
      env: { ...localProcessEnvironment(), LANG: "C", LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 8_192,
      timeout: 2_000,
    };
    const [started, command] = await Promise.all([
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], options),
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="], options),
    ]);
    const startedAt = started.stdout.trim();
    const executable = command.stdout.trim();
    return startedAt && executable ? { executable, startedAt } : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number, group = false): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateOrphanedProcessGroups(owner: StorageLockOwner): Promise<void> {
  for (const group of owner.activeGroups || []) {
    if (!processIsRunning(group.pid, true)) continue;
    const identity = await readProcessIdentity(group.pid);
    const pendingExecutableMatches = group.startedAt === "pending" && Boolean(
      identity && (
        path.isAbsolute(group.executable)
          ? identity.executable === group.executable
          : path.basename(identity.executable) === path.basename(group.executable)
      )
    );
    const recordedIdentityMatches = Boolean(
      identity &&
      identity.startedAt === group.startedAt &&
      identity.executable === group.executable
    );
    if (!pendingExecutableMatches && !recordedIdentityMatches) {
      throw new LocalH3Error(
        "A stale storage lock references a process group that cannot be safely identified.",
        503,
        "local_storage_locked",
        false,
      );
    }
    try {
      process.kill(-group.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const group of owner.activeGroups || []) {
    for (let attempt = 0; attempt < 20 && processIsRunning(group.pid, true); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processIsRunning(group.pid, true)) {
      throw new LocalH3Error(
        "An orphaned local process group could not be stopped before storage cleanup.",
        503,
        "local_storage_locked",
        true,
      );
    }
  }
}

function storageLockOwner(): StorageLockOwner {
  return {
    pid: process.pid,
    token: storageLockToken,
    serverStartedAt: storageServerStartedAt,
    activeGroups: [...persistedProcessGroups.values()],
  };
}

function writeStorageLockOwnerSync(): void {
  if (!storageLockPath) throw new Error("H3_JOBS_DIR lock is not held.");
  const temporary = path.join(storageLockPath, `.owner-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(storageLockOwner())}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path.join(storageLockPath, STORAGE_LOCK_OWNER));
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The atomic rename normally consumes the temporary file.
    }
  }
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

function assertLocalH3Supported(): void {
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
}

async function resolveJobsDirectory(): Promise<string> {
  assertLocalH3Supported();
  const configuredJobsDirectory = process.env.H3_JOBS_DIR?.trim();
  if (configuredJobsDirectory && !path.isAbsolute(configuredJobsDirectory)) {
    throw new LocalH3Error(
      "H3_JOBS_DIR must be an absolute path.",
      503,
      "local_configuration_error",
      false,
    );
  }
  const jobsDirectory = configuredJobsDirectory || path.resolve(process.cwd(), ".h3-jobs");
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
  return jobsDirectory;
}

function beginLocalOperation(): () => void {
  assertLocalOperationMayContinue();
  inFlightOperations += 1;
  return () => {
    inFlightOperations -= 1;
    if (inFlightOperations === 0) {
      for (const resolve of idleResolvers) resolve();
      idleResolvers.clear();
    }
  };
}

function assertLocalOperationMayContinue(): void {
  if (shuttingDown || !storageReady) {
    throw new LocalH3Error(
      shuttingDown
        ? "The local h3.c service is shutting down."
        : "The local h3.c storage lifecycle is not available.",
      503,
      shuttingDown ? "local_service_stopping" : "local_storage_unavailable",
      true,
    );
  }
}

function assertLocalWorkspaceActive(workspaceToken: string): void {
  if (!discardedWorkspaces.has(workspaceToken)) return;
  throw new LocalH3Error(
    "This local workspace has been cleared.",
    410,
    "local_workspace_cleared",
    false,
  );
}

function retireLocalWorkspace(workspaceToken: string): void {
  discardedWorkspaces.add(workspaceToken);
}

async function removeOwnedArtifact(
  target: string,
  recursive: boolean,
  onRemoved?: () => void,
): Promise<void> {
  if (shuttingDown) return;
  try {
    await rm(target, { recursive, force: true });
    onRemoved?.();
  } catch {
    const retry = setTimeout(
      () => void removeOwnedArtifact(target, recursive, onRemoved),
      5_000,
    );
    retry.unref();
  }
}

function waitForLocalOperations(): Promise<void> {
  if (inFlightOperations === 0) return Promise.resolve();
  return new Promise((resolve) => idleResolvers.add(resolve));
}

async function acquireStorageLock(jobsDirectory: string): Promise<void> {
  const lockPath = path.join(jobsDirectory, STORAGE_LOCK);
  const ownerPath = path.join(lockPath, STORAGE_LOCK_OWNER);
  const candidatePath = `${lockPath}.candidate-${storageLockToken}`;
  storageServerStartedAt = (await readProcessIdentity(process.pid))?.startedAt;
  const contents = `${JSON.stringify(storageLockOwner())}\n`;
  await mkdir(candidatePath, { mode: 0o700 });
  try {
    await writeFile(path.join(candidatePath, STORAGE_LOCK_OWNER), contents, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rename(candidatePath, lockPath);
        storageLockPath = lockPath;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }

      const observedLock = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!observedLock) continue;
      if (observedLock.isSymbolicLink()) {
        throw new LocalH3Error(
          "H3_JOBS_DIR contains an unsafe storage lock.",
          503,
          "local_storage_locked",
          false,
        );
      }
      let existing: string;
      try {
        existing = await readFile(ownerPath, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        try {
          existing = await readFile(lockPath, "utf8");
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") continue;
          if ((legacyError as NodeJS.ErrnoException).code !== "EISDIR") throw legacyError;
          existing = "";
        }
      }
      let owner: StorageLockOwner | undefined;
      let pid = 0;
      try {
        const parsed = JSON.parse(existing) as Partial<StorageLockOwner>;
        if (typeof parsed.pid === "number") {
          pid = parsed.pid;
          owner = {
            pid,
            token: typeof parsed.token === "string" ? parsed.token : "",
            serverStartedAt:
              typeof parsed.serverStartedAt === "string" ? parsed.serverStartedAt : undefined,
            activeGroups: Array.isArray(parsed.activeGroups)
              ? parsed.activeGroups.filter((group): group is StorageProcessGroup => (
                  typeof group === "object" &&
                  group !== null &&
                  typeof group.pid === "number" &&
                  typeof group.startedAt === "string" &&
                  typeof group.executable === "string"
                ))
              : undefined,
          };
        }
      } catch {
        const legacyPid = Number(existing.trim());
        if (Number.isInteger(legacyPid)) pid = legacyPid;
      }
      if (pid < 1) {
        throw new LocalH3Error(
          "H3_JOBS_DIR contains an ownerless or malformed storage lock.",
          503,
          "local_storage_locked",
          false,
        );
      }
      if (processIsRunning(pid)) {
        if (!owner?.serverStartedAt) {
          throw new LocalH3Error(
            "H3_JOBS_DIR is already owned by another running Motio server.",
            503,
            "local_storage_locked",
            true,
          );
        }
        const identity = await readProcessIdentity(pid);
        if (!identity || identity.startedAt === owner.serverStartedAt) {
          throw new LocalH3Error(
            "H3_JOBS_DIR is already owned by another running Motio server.",
            503,
            "local_storage_locked",
            true,
          );
        }
        await terminateOrphanedProcessGroups(owner);
      } else if (owner) {
        await terminateOrphanedProcessGroups(owner);
      }

      const stalePath = `${lockPath}.stale-${observedLock.dev}-${observedLock.ino}`;
      try {
        await rename(lockPath, stalePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") continue;
        throw error;
      }
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
  }
  throw new LocalH3Error(
    "H3_JOBS_DIR could not be locked for this server.",
    503,
    "local_storage_locked",
    true,
  );
}

async function releaseStorageLock(): Promise<void> {
  if (!storageLockPath) return;
  const lockPath = storageLockPath;
  const contents = await readFile(path.join(lockPath, STORAGE_LOCK_OWNER), "utf8");
  if (contents.includes(`"token":"${storageLockToken}"`)) {
    const lockInfo = await lstat(lockPath);
    const tombstone = `${lockPath}.stale-${lockInfo.dev}-${lockInfo.ino}`;
    await rename(lockPath, tombstone);
    storageLockPath = undefined;
    await rm(tombstone, { recursive: true, force: true });
    return;
  }
  throw new Error("H3_JOBS_DIR lock ownership changed before release.");
}

async function isOwnedStorageLockTombstone(tombstonePath: string): Promise<boolean> {
  const info = await lstat(tombstonePath).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return false;
  if (path.basename(tombstonePath) !== `${STORAGE_LOCK}.stale-${info.dev}-${info.ino}`) return false;
  const owner = info.isDirectory()
    ? await readFile(path.join(tombstonePath, STORAGE_LOCK_OWNER), "utf8").catch(() => "")
    : info.isFile()
      ? await readFile(tombstonePath, "utf8").catch(() => "")
      : "";
  return Boolean(owner.trim());
}

async function ensureStorageOwnership(jobsDirectory: string): Promise<void> {
  const marker = path.join(jobsDirectory, STORAGE_OWNER);
  try {
    const contents = await readFile(marker, "utf8");
    if (contents !== STORAGE_OWNER_CONTENT) throw new Error("unexpected ownership marker");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LocalH3Error(
        "H3_JOBS_DIR has an invalid Motio ownership marker.",
        503,
        "local_storage_ownership_error",
        false,
      );
    }
  }

  const entries = await readdir(jobsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === STORAGE_LOCK && entry.isDirectory()) continue;
    if (
      STORAGE_LOCK_TOMBSTONE.test(entry.name) &&
      await isOwnedStorageLockTombstone(path.join(jobsDirectory, entry.name))
    ) continue;
    if (entry.name === "reference-images" && entry.isDirectory()) {
      const references = await readdir(path.join(jobsDirectory, entry.name));
      if (references.length === 0) continue;
    }
    throw new LocalH3Error(
      "H3_JOBS_DIR is not empty and is not marked as Motio-owned storage.",
      503,
      "local_storage_ownership_error",
      false,
    );
  }
  await writeFile(marker, STORAGE_OWNER_CONTENT, { flag: "wx", mode: 0o600 });
}

async function cleanReferenceStorage(jobsDirectory: string): Promise<void> {
  const referenceDirectory = path.join(jobsDirectory, "reference-images");
  const referenceInfo = await lstat(referenceDirectory).catch(() => undefined);
  if (!referenceInfo?.isDirectory() || referenceInfo.isSymbolicLink()) return;

  const references = await readdir(referenceDirectory, { withFileTypes: true });
  for (const reference of references) {
    if (reference.isFile() && REFERENCE_IMAGE_NAME.test(reference.name)) {
      await rm(path.join(referenceDirectory, reference.name), { force: true });
    }
  }
  if ((await readdir(referenceDirectory)).length === 0) {
    await rmdir(referenceDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }
}

async function cleanOwnedStorage(jobsDirectory: string): Promise<void> {
  const entries = await readdir(jobsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(jobsDirectory, entry.name);
    if (
      (entry.isDirectory() && LOCAL_JOB_ID.test(entry.name)) ||
      (STORAGE_LOCK_TOMBSTONE.test(entry.name) && await isOwnedStorageLockTombstone(entryPath))
    ) {
      await rm(entryPath, { recursive: true, force: true });
    }
  }

  await cleanReferenceStorage(jobsDirectory);

  jobs.clear();
  queue.length = 0;
  referenceUploads.clear();
  discardedWorkspaces.clear();
}

export async function initializeLocalH3Storage(): Promise<void> {
  if (!isLocalH3Supported()) return;
  const jobsDirectory = await resolveJobsDirectory();
  await acquireStorageLock(jobsDirectory);
  try {
    await ensureStorageOwnership(jobsDirectory);
    await cleanOwnedStorage(jobsDirectory);
    storageReady = true;
  } catch (error) {
    await releaseStorageLock();
    throw error;
  }
}

export function beginLocalH3Shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  storageReady = false;
  queue.length = 0;
}

export async function shutdownLocalH3Storage(): Promise<void> {
  beginLocalH3Shutdown();

  const shutdownGroups = [...childProcessGroups];
  signalChildProcessGroups("SIGTERM", shutdownGroups);
  const forceKill = setTimeout(() => signalChildProcessGroups("SIGKILL", shutdownGroups), 10_000);
  forceKill.unref();
  try {
    await activeExecution?.catch(() => undefined);
    await waitForLocalOperations();
  } finally {
    clearTimeout(forceKill);
    signalChildProcessGroups("SIGKILL", shutdownGroups);
  }

  const jobsDirectory = storageLockPath ? path.dirname(storageLockPath) : undefined;
  try {
    if (jobsDirectory) await cleanOwnedStorage(jobsDirectory);
  } finally {
    await releaseStorageLock();
  }
}

async function resolveRuntime(): Promise<LocalH3Runtime> {
  assertLocalH3Supported();

  const binary = configuredPath("H3_BINARY");
  const modelDirectory = configuredPath("H3_MODEL_DIR");
  const configuredRuntimeDirectory = process.env.H3_RUNTIME_DIR?.trim();
  if (configuredRuntimeDirectory && !path.isAbsolute(configuredRuntimeDirectory)) {
    throw new LocalH3Error(
      "H3_RUNTIME_DIR must be an absolute path.",
      503,
      "local_configuration_error",
      false,
    );
  }
  const runtimeDirectory = configuredRuntimeDirectory || path.dirname(binary);

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

  const jobsDirectory = await resolveJobsDirectory();
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

function serializeReferenceProcessing<T>(work: () => Promise<T>): Promise<T> {
  const operation = referenceProcessingTail.then(() => {
    assertLocalOperationMayContinue();
    return work();
  });
  referenceProcessingTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function inspectReferenceImage(filePath: string): Promise<void> {
  assertLocalOperationMayContinue();
  const command = process.env.H3_FFPROBE?.trim() || "ffprobe";
  let child: ChildProcess | undefined;
  let activation: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child = spawn(command, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        filePath,
      ], {
        detached: true,
        env: localProcessEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      trackChildProcess(child);
      let output = "";
      let settled = false;
      let terminationError: LocalH3Error | undefined;
      const finish = (error?: LocalH3Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        terminationError = new LocalH3Error(
          "The reference image could not be inspected within 15 seconds.",
          400,
          "local_reference_error",
          false,
        );
        signalProcessGroup(child!, "SIGKILL");
      }, 15_000);
      timeout.unref();

      child.stdout!.on("data", (chunk: Buffer) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-1_024);
      });
      child.once("error", () => finish(new LocalH3Error(
        "FFprobe is required to inspect local reference images.",
        503,
        "local_configuration_error",
        false,
      )));
      child.once("close", (code) => {
        if (terminationError) {
          finish(terminationError);
          return;
        }
        const match = output.trim().match(/^(\d+)x(\d+)$/);
        const width = Number(match?.[1]);
        const height = Number(match?.[2]);
        const aspect = Math.max(width / height, height / width);
        if (
          code === 0 &&
          Number.isInteger(width) &&
          Number.isInteger(height) &&
          width > 0 &&
          height > 0 &&
          width * height <= MAX_REFERENCE_IMAGE_PIXELS &&
          aspect <= MAX_REFERENCE_ASPECT_RATIO
        ) {
          finish();
          return;
        }
        finish(new LocalH3Error(
          "Reference images must be decodable, at most 50 megapixels, and no more extreme than a 16:1 aspect ratio.",
          400,
          "local_reference_error",
          false,
        ));
      });
      activation = activateProcessGroup(child, command);
      void activation.catch((error) => {
        terminationError = new LocalH3Error(
          error instanceof Error ? error.message : "The FFprobe process could not be supervised.",
          503,
          "local_storage_error",
          true,
        );
        signalProcessGroup(child!, "SIGKILL");
      });
    });
  } finally {
    try {
      await activation;
    } finally {
      if (child) deactivateProcessGroup(child);
    }
  }
}

async function probeReferenceImage(filePath: string): Promise<void> {
  await inspectReferenceImage(filePath);
  assertLocalOperationMayContinue();
  const command = process.env.H3_FFMPEG?.trim() || "ffmpeg";
  let child: ChildProcess | undefined;
  let activation: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child = spawn(command, [
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
        detached: true,
        env: localProcessEnvironment(),
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
      trackChildProcess(child);
      let settled = false;
      let terminationError: LocalH3Error | undefined;
      const finish = (error?: LocalH3Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        terminationError = new LocalH3Error(
          "The reference image could not be decoded within 15 seconds.",
          400,
          "local_reference_error",
          false,
        );
        signalProcessGroup(child!, "SIGKILL");
      }, 15_000);
      timeout.unref();

      child.once("error", () => finish(new LocalH3Error(
        "FFmpeg is required to validate local reference images.",
        503,
        "local_configuration_error",
        false,
      )));
      child.once("close", (code) => {
        if (terminationError) {
          finish(terminationError);
          return;
        }
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
      activation = activateProcessGroup(child, command);
      void activation.catch((error) => {
        terminationError = new LocalH3Error(
          error instanceof Error ? error.message : "The FFmpeg process could not be supervised.",
          503,
          "local_storage_error",
          true,
        );
        signalProcessGroup(child!, "SIGKILL");
      });
    });
  } finally {
    try {
      await activation;
    } finally {
      if (child) deactivateProcessGroup(child);
    }
  }
}

async function processReferenceImage(
  source: string,
  directory: string,
  name: string,
  width: number,
  height: number,
  fit: LocalH3FrameFitId,
): Promise<string> {
  assertLocalOperationMayContinue();
  const command = process.env.H3_FFMPEG?.trim() || "ffmpeg";
  const output = path.join(directory, `${name}-framed.png`);
  const filter = fit === "cover"
    ? `setsar=1,crop='if(gt(iw/ih,${width}/${height}),ih*${width}/${height},iw)':'if(gt(iw/ih,${width}/${height}),ih,iw*${height}/${width})',scale=${width}:${height},setsar=1`
    : `setsar=1,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  let child: ChildProcess | undefined;
  let activation: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child = spawn(command, [
        "-v",
        "error",
        "-nostdin",
        "-i",
        source,
        "-vf",
        filter,
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-pix_fmt",
        "rgb24",
        output,
      ], {
        detached: true,
        env: localProcessEnvironment(),
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
      trackChildProcess(child);
      let diagnostics = "";
      let settled = false;
      let terminationError: LocalH3Error | undefined;
      const finish = (error?: LocalH3Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        terminationError = new LocalH3Error(
          "Reference-image framing exceeded 30 seconds.",
          400,
          "local_reference_error",
          false,
        );
        signalProcessGroup(child!, "SIGKILL");
      }, 30_000);
      timeout.unref();

      child.stderr!.on("data", (chunk: Buffer) => {
        diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-2_000);
      });
      child.once("error", () => finish(new LocalH3Error(
        "FFmpeg is required to frame local reference images.",
        503,
        "local_configuration_error",
        false,
      )));
      child.once("close", (code) => {
        if (terminationError) {
          finish(terminationError);
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        const detail = diagnostics.trim();
        finish(new LocalH3Error(
          detail
            ? `The reference image could not be framed: ${detail}`
            : "The reference image could not be framed for the selected resolution.",
          400,
          "local_reference_error",
          false,
        ));
      });
      activation = activateProcessGroup(child, command);
      void activation.catch((error) => {
        terminationError = new LocalH3Error(
          error instanceof Error ? error.message : "The FFmpeg process could not be supervised.",
          503,
          "local_storage_error",
          true,
        );
        signalProcessGroup(child!, "SIGKILL");
      });
    });
  } finally {
    try {
      await activation;
    } finally {
      if (child) deactivateProcessGroup(child);
    }
  }

  const framed = await stat(output).catch(() => undefined);
  if (!framed?.isFile() || framed.size < 1) {
    throw new LocalH3Error(
      "FFmpeg did not create the framed reference image.",
      500,
      "local_storage_error",
      true,
    );
  }
  await chmod(output, 0o600);
  return output;
}

async function prepareReferenceDirectory(directory: string, allowReplacement: boolean): Promise<void> {
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
  const expiredPaths = new Set(expired.map((file) => file.path));
  for (const [token, upload] of referenceUploads) {
    if (expiredPaths.has(upload.path)) referenceUploads.delete(token);
  }
  if (!allowReplacement && retained.length - expired.length >= MAX_RETAINED_REFERENCE_IMAGES) {
    throw new LocalH3Error(
      "The local reference-image staging area is full. Remove unused images or wait for staged images to expire.",
      429,
      "local_reference_limit",
      true,
    );
  }
}

async function ownedReferenceUpload(
  token: string | undefined,
  directory: string,
  workspaceToken: string,
): Promise<string | undefined> {
  if (!token) return undefined;
  const upload = referenceUploads.get(token);
  const candidate = upload?.path;
  if (
    !candidate ||
    upload.workspaceToken !== workspaceToken ||
    path.dirname(candidate) !== path.resolve(directory) ||
    !REFERENCE_IMAGE_NAME.test(path.basename(candidate))
  ) {
    return undefined;
  }
  const file = await lstat(candidate).catch(() => undefined);
  if (!file?.isFile() || file.isSymbolicLink()) {
    referenceUploads.delete(token);
    return undefined;
  }
  return candidate;
}

async function storeLocalReferenceImage(
  data: Buffer,
  uploadToken: string,
  workspaceToken: string,
  previousToken?: string,
): Promise<{ path: string; token: string }> {
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

  const jobsDirectory = await resolveJobsDirectory();
  const directory = path.join(jobsDirectory, "reference-images");
  const registeredUpload = referenceUploads.get(uploadToken);
  if (registeredUpload && registeredUpload.workspaceToken !== workspaceToken) {
    throw new LocalH3Error(
      "The reference upload token belongs to another local workspace.",
      409,
      "local_reference_conflict",
      false,
    );
  }
  const existingPath = await ownedReferenceUpload(uploadToken, directory, workspaceToken);
  if (existingPath) return { path: existingPath, token: uploadToken };
  const previousPath = await ownedReferenceUpload(previousToken, directory, workspaceToken);
  const output = path.join(directory, `${randomUUID()}${extension}`);
  try {
    await serializeReferenceProcessing(async () => {
      await prepareReferenceDirectory(directory, Boolean(previousPath));
      await writeFile(output, data, { flag: "wx", mode: 0o600 });
      await probeReferenceImage(output);
      if (previousPath) await rm(previousPath, { force: true });
    });
  } catch (error) {
    await removeOwnedArtifact(output, false);
    throw error;
  }

  if (previousToken && previousPath) referenceUploads.delete(previousToken);
  referenceUploads.set(uploadToken, { path: output, workspaceToken });
  return { path: output, token: uploadToken };
}

export function uploadLocalReferenceImage(
  data: Buffer,
  uploadToken: string,
  workspaceToken: string,
  previousToken?: string,
): Promise<{ path: string; token: string }> {
  const release = beginLocalOperation();
  const operation = referenceUploadTail.then(() => {
    assertLocalOperationMayContinue();
    assertLocalWorkspaceActive(workspaceToken);
    return storeLocalReferenceImage(data, uploadToken, workspaceToken, previousToken);
  });
  referenceUploadTail = operation.then(() => undefined, () => undefined);
  return operation.finally(release);
}

export function deleteLocalReferenceImage(token: string, workspaceToken: string): Promise<{ deleted: boolean }> {
  const release = beginLocalOperation();
  const operation = referenceUploadTail.then(async () => {
    assertLocalOperationMayContinue();
    const jobsDirectory = await resolveJobsDirectory();
    const directory = path.join(jobsDirectory, "reference-images");
    const candidate = await ownedReferenceUpload(token, directory, workspaceToken);
    if (!candidate) return { deleted: false };
    await serializeReferenceProcessing(() => rm(candidate, { force: true }));
    referenceUploads.delete(token);
    return { deleted: true };
  });
  referenceUploadTail = operation.then(() => undefined, () => undefined);
  return operation.finally(release);
}

export function discardLocalH3Workspace(workspaceToken: string): Promise<{ cleared: true }> {
  if (!isLocalH3Supported()) return Promise.resolve({ cleared: true });
  const release = beginLocalOperation();
  retireLocalWorkspace(workspaceToken);
  const activeJob = activeJobId ? jobs.get(activeJobId) : undefined;
  const discardedActiveExecution = activeJob?.workspaceToken === workspaceToken ? activeExecution : undefined;
  for (const job of jobs.values()) {
    if (job.workspaceToken === workspaceToken) job.discardOnCompletion = true;
  }
  if (activeJob?.workspaceToken === workspaceToken) {
    activeJob.cancelRequested = true;
    stopActiveJob?.();
  }
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const job = jobs.get(queue[index]);
    if (job?.workspaceToken === workspaceToken) queue.splice(index, 1);
  }
  const operation = referenceUploadTail.then(async () => {
    assertLocalOperationMayContinue();
    await discardedActiveExecution;
    let cleanupError: unknown;
    for (const job of jobs.values()) {
      if (
        job.workspaceToken !== workspaceToken ||
        !job.discardOnCompletion ||
        job.id === activeJobId
      ) continue;
      try {
        await rm(job.directory, { recursive: true, force: true });
        jobs.delete(job.id);
      } catch (error) {
        cleanupError ??= error;
        void removeOwnedArtifact(job.directory, true, () => jobs.delete(job.id));
      }
    }
    await serializeReferenceProcessing(async () => {
      for (const [token, upload] of referenceUploads) {
        if (upload.workspaceToken !== workspaceToken) continue;
        try {
          await rm(upload.path, { force: true });
          referenceUploads.delete(token);
        } catch (error) {
          cleanupError ??= error;
          void removeOwnedArtifact(upload.path, false, () => referenceUploads.delete(token));
        }
      }
    });
    if (cleanupError) throw cleanupError;
    return { cleared: true } as const;
  });
  referenceUploadTail = operation.then(() => undefined, () => undefined);
  return operation.finally(release);
}

export function deleteLocalVideoJob(id: string, workspaceToken: string): Promise<{ deleted: true }> {
  assertLocalWorkspaceActive(workspaceToken);
  const release = beginLocalOperation();
  const operation = (async () => {
    const job = jobs.get(id);
    if (!job || job.workspaceToken !== workspaceToken) {
      throw new LocalH3Error(
        "The local generation job was not found. Local jobs are lost when the server restarts.",
        404,
        "local_job_not_found",
        false,
      );
    }

    job.discardOnCompletion = true;
    const queueIndex = queue.indexOf(id);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);

    if (id === activeJobId) {
      job.cancelRequested = true;
      const execution = activeExecution;
      stopActiveJob?.();
      await execution;
      if (jobs.has(id)) {
        await rm(job.directory, { recursive: true, force: true });
        jobs.delete(id);
      }
    } else {
      await rm(job.directory, { recursive: true, force: true });
      jobs.delete(id);
    }
    return { deleted: true } as const;
  })();
  return operation.finally(release);
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

function prepareReferenceImage(
  source: string,
  directory: string,
  name: string,
  width: number,
  height: number,
  fit: LocalH3FrameFitId,
): Promise<string> {
  return serializeReferenceProcessing(async () => {
    const copied = await copyReferenceImage(source, directory, name);
    return processReferenceImage(copied, directory, name, width, height, fit);
  });
}

async function assertReferenceSourceOwned(
  source: string,
  jobsDirectory: string,
  workspaceToken: string,
): Promise<void> {
  const enteredReferenceDirectory = path.join(jobsDirectory, "reference-images");
  const referenceDirectory = await realpath(enteredReferenceDirectory).catch(() => enteredReferenceDirectory);
  const enteredSource = path.resolve(source);
  const resolvedSource = await realpath(source).catch(() => enteredSource);
  if (
    path.dirname(enteredSource) !== enteredReferenceDirectory &&
    path.dirname(resolvedSource) !== referenceDirectory
  ) return;
  let upload: { path: string; workspaceToken: string } | undefined;
  for (const candidate of referenceUploads.values()) {
    const enteredCandidate = path.resolve(candidate.path);
    const resolvedCandidate = await realpath(candidate.path).catch(() => enteredCandidate);
    if (enteredCandidate === enteredSource || resolvedCandidate === resolvedSource) {
      upload = candidate;
      break;
    }
  }
  if (upload?.workspaceToken === workspaceToken) return;
  throw new LocalH3Error(
    "The staged reference image belongs to another local workspace.",
    403,
    "local_reference_forbidden",
    false,
  );
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

async function writeTerminalMarker(job: LocalJob, status: "completed" | "failed"): Promise<void> {
  const temporary = path.join(job.directory, `${TERMINAL_MARKER}.tmp`);
  const marker = path.join(job.directory, TERMINAL_MARKER);
  await writeFile(temporary, `${status}\n`, { flag: "w", mode: 0o600 });
  await rename(temporary, marker);
}

async function executeJob(job: LocalJob): Promise<void> {
  // ponytail: queued jobs are created only from route-validated static presets.
  const resolution = getLocalH3Resolution(job.input.resolution)!;
  const quality = getLocalH3QualityPreset(job.input.quality)!;
  const acceleration = getLocalH3AccelerationPreset(job.input.acceleration)!;

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

  if (acceleration.tokenReduction) args.push("--token-reduction");
  if (acceleration.renderWidth && acceleration.renderHeight) {
    args.push(
      "--render-width",
      String(acceleration.renderWidth),
      "--render-height",
      String(acceleration.renderHeight),
    );
  }
  if (job.input.ssdStreaming) args.push("--ssd-streaming");
  if (job.firstFrame) args.push("--first-frame", job.firstFrame);
  if (job.lastFrame) args.push("--last-frame", job.lastFrame);
  args.push("-o", job.temporaryOutput);

  job.status = "processing";
  job.phase = "Starting h3.c";
  job.progress = 0;

  try {
    let timedOut = false;
    const child = spawn(job.runtime.binary, args, {
      cwd: job.runtime.runtimeDirectory,
      detached: true,
      env: localProcessEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChildProcess(child);
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      forceKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 10_000);
      forceKill.unref();
    }, jobTimeoutMs());
    timeout.unref();
    stopActiveJob = () => {
      signalProcessGroup(child, "SIGTERM");
      if (!forceKill) {
        forceKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 10_000);
        forceKill.unref();
      }
    };

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
    const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", (error) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          reject(error);
        });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          if (forceKill) {
            clearTimeout(forceKill);
            signalProcessGroup(child, "SIGKILL");
          }
          resolve({ code, signal });
        });
      },
    );

    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      try {
        await activateProcessGroup(child, job.runtime.binary);
      } catch (error) {
        signalProcessGroup(child, "SIGKILL");
        await resultPromise.catch(() => undefined);
        throw error;
      }
      result = await resultPromise;
    } finally {
      stopActiveJob = undefined;
      deactivateProcessGroup(child);
    }

    if (job.progressCarry) parseProgressLine(job, job.progressCarry);
    if (job.cancelRequested) {
      throw new Error("Local h3.c generation was stopped.");
    }
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
    await writeTerminalMarker(job, "completed").catch(() => undefined);
  } catch (error) {
    await rm(job.temporaryOutput, { force: true }).catch(() => undefined);
    job.status = "failed";
    job.phase = "Failed";
    job.error = error instanceof Error ? error.message : "Local h3.c generation failed.";
    await writeTerminalMarker(job, "failed").catch(() => undefined);
  }
}

function startNextJob(): void {
  if (shuttingDown || activeJobId) return;
  const id = queue.shift();
  if (!id) return;

  const job = jobs.get(id);
  if (!job) {
    startNextJob();
    return;
  }

  activeJobId = id;
  const execution = executeJob(job).finally(async () => {
    if (job.discardOnCompletion) {
      await removeOwnedArtifact(job.directory, true, () => jobs.delete(id));
    }
    activeJobId = undefined;
    if (activeExecution === execution) activeExecution = undefined;
    startNextJob();
  });
  activeExecution = execution;
  void execution;
}

export function isLocalJobId(id: string): boolean {
  return LOCAL_JOB_ID.test(id);
}

async function generateLocalVideoOperation(
  input: LocalGenerateVideoInput,
  workspaceToken: string,
): Promise<VideoStatusResponse> {
  const runtime = await resolveRuntime();
  // ponytail: the sole caller validates this static preset before dispatch.
  const resolution = getLocalH3Resolution(input.resolution)!;
  const firstFrameSource = input.firstFramePath;
  const lastFrameSource = input.lastFramePath;
  if (firstFrameSource) await assertReferenceSourceOwned(firstFrameSource, runtime.jobsDirectory, workspaceToken);
  if (lastFrameSource) await assertReferenceSourceOwned(lastFrameSource, runtime.jobsDirectory, workspaceToken);
  if (queue.length + pendingJobReservations >= MAX_QUEUED_JOBS) {
    throw new LocalH3Error(
      "The local h3.c queue is full. Wait for an existing generation to finish.",
      429,
      "local_queue_full",
      true,
    );
  }
  pendingJobReservations += 1;
  const id = `local_${randomUUID()}`;

  try {
    const directory = path.join(runtime.jobsDirectory, id);
    await mkdir(directory, { recursive: false, mode: 0o700 });

    let firstFrame: string | undefined;
    let lastFrame: string | undefined;
    try {
      if (firstFrameSource) {
        firstFrame = await prepareReferenceImage(
          firstFrameSource,
          directory,
          "first-frame",
          resolution.width,
          resolution.height,
          input.frameFit,
        );
      }
      if (lastFrameSource) {
        lastFrame = await prepareReferenceImage(
          lastFrameSource,
          directory,
          "last-frame",
          resolution.width,
          resolution.height,
          input.frameFit,
        );
      }
    } catch (error) {
      await removeOwnedArtifact(directory, true);
      if (error instanceof LocalH3Error) throw error;
      throw new LocalH3Error(
        "The server could not copy a reference image into the local job.",
        500,
        "local_storage_error",
        true,
      );
    }

    try {
      assertLocalWorkspaceActive(workspaceToken);
    } catch (error) {
      await removeOwnedArtifact(directory, true);
      throw error;
    }

    const job: LocalJob = {
      id,
      workspaceToken,
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
    };

    if (shuttingDown) {
      await rm(directory, { recursive: true, force: true });
      throw new LocalH3Error(
        "The local h3.c service is shutting down.",
        503,
        "local_service_stopping",
        true,
      );
    }
    jobs.set(id, job);
    queue.push(id);
    startNextJob();
    return toResponse(job);
  } finally {
    pendingJobReservations -= 1;
  }
}

export function generateLocalVideo(input: LocalGenerateVideoInput, workspaceToken: string): Promise<VideoStatusResponse> {
  assertLocalWorkspaceActive(workspaceToken);
  const release = beginLocalOperation();
  return generateLocalVideoOperation(input, workspaceToken).finally(release);
}

export function getLocalVideoStatus(id: string, workspaceToken: string): VideoStatusResponse {
  assertLocalWorkspaceActive(workspaceToken);
  const job = jobs.get(id);
  if (!job || job.workspaceToken !== workspaceToken) {
    throw new LocalH3Error(
      "The local generation job was not found. Local jobs are lost when the server restarts.",
      404,
      "local_job_not_found",
      false,
    );
  }
  return toResponse(job);
}

export async function getLocalVideoPath(id: string, workspaceToken: string): Promise<string> {
  assertLocalWorkspaceActive(workspaceToken);
  const job = jobs.get(id);
  if (!job || job.workspaceToken !== workspaceToken) {
    throw new LocalH3Error(
      "The local generation job was not found. Local jobs are lost when the server restarts.",
      404,
      "local_job_not_found",
      false,
    );
  }
  if (job && job.status !== "completed") {
    throw new LocalH3Error(
      "The local video is not ready yet.",
      409,
      "local_video_not_ready",
      true,
    );
  }

  const jobsDirectory = job.runtime.jobsDirectory;
  const expectedOutput = job.output;
  const resolvedJobsDirectory = await realpath(jobsDirectory);
  const resolvedOutput = await realpath(expectedOutput).catch(() => undefined);
  const output = resolvedOutput?.startsWith(`${resolvedJobsDirectory}${path.sep}`)
    ? await stat(resolvedOutput).catch(() => undefined)
    : undefined;
  if (!resolvedOutput || !output?.isFile()) {
    throw new LocalH3Error(
      "The completed local video file is missing.",
      404,
      "local_video_missing",
      false,
    );
  }
  return resolvedOutput;
}
