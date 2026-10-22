import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteLocalReferenceImage,
  deleteLocalVideoJob,
  discardLocalH3Workspace,
  generateLocalVideo,
  getLocalVideoStatus,
  initializeLocalH3Storage,
  LocalH3Error,
  shutdownLocalH3Storage,
  uploadLocalReferenceImage,
} from "../server/localH3.js";
import type { LocalGenerateVideoInput } from "../server/validation.js";

const input = (prompt: string): LocalGenerateVideoInput => ({
  provider: "local",
  prompt,
  resolution: "256x256",
  frames: 22,
  quality: "draft",
  acceleration: "standard",
  seed: 42,
  frameFit: "contain",
  ssdStreaming: false,
});

async function waitFor(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for the fake h3.c process.");
}

test("local h3.c deletes failed/completed jobs and isolates workspace jobs and references", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-h3-test-"));
  const jobsDirectory = path.join(directory, "jobs");
  const modelDirectory = path.join(directory, "model");
  const binary = path.join(directory, "fake-h3");
  const referenceTool = path.join(directory, "fake-reference-tool");
  const started = path.join(directory, "started");
  const previous = {
    binary: process.env.H3_BINARY,
    jobs: process.env.H3_JOBS_DIR,
    model: process.env.H3_MODEL_DIR,
    runtime: process.env.H3_RUNTIME_DIR,
    ffprobe: process.env.H3_FFPROBE,
    ffmpeg: process.env.H3_FFMPEG,
  };

  await mkdir(jobsDirectory);
  await mkdir(modelDirectory);
  await writeFile(path.join(directory, "h3_shaders.metal"), "test");
  await writeFile(binary, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const output = process.argv[process.argv.indexOf("-o") + 1];
if (prompt === "complete") {
  writeFileSync(output, "video");
} else if (prompt === "fail") {
  console.error("private engine detail: /Users/test/secret-model");
  process.exit(1);
} else {
  console.error("private progress detail: /Users/test/secret-model 1/2");
  writeFileSync(${JSON.stringify(started)}, "started");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
  await chmod(binary, 0o700);
  await writeFile(referenceTool, '#!/usr/bin/env node\nif (process.argv.includes("-show_entries")) console.log("1x1");\n', { mode: 0o700 });
  process.env.H3_BINARY = binary;
  process.env.H3_JOBS_DIR = jobsDirectory;
  process.env.H3_MODEL_DIR = modelDirectory;
  process.env.H3_RUNTIME_DIR = directory;
  process.env.H3_FFPROBE = referenceTool;
  process.env.H3_FFMPEG = referenceTool;

  try {
    await initializeLocalH3Storage();
    const workspaceToken = crypto.randomUUID();
    const otherWorkspace = crypto.randomUUID();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=", "base64");
    const manualReference = path.join(directory, "manual.png");
    await writeFile(manualReference, png);
    const reference = await uploadLocalReferenceImage(png, crypto.randomUUID(), workspaceToken);
    const otherReference = await uploadLocalReferenceImage(png, crypto.randomUUID(), otherWorkspace);
    assert.deepEqual(await deleteLocalReferenceImage(reference.token, otherWorkspace), { deleted: false });
    assert.deepEqual(await deleteLocalReferenceImage(manualReference, workspaceToken), { deleted: false });
    await assert.rejects(uploadLocalReferenceImage(png, reference.token, otherWorkspace),
      (error) => error instanceof LocalH3Error && error.type === "local_reference_conflict");
    const active = await generateLocalVideo(input("wait"), workspaceToken);
    await waitFor(async () => (await readdir(directory)).includes("started"));
    await waitFor(() => getLocalVideoStatus(active.id, workspaceToken).phase === "Generating video");
    await assert.rejects(deleteLocalVideoJob(active.id, otherWorkspace),
      (error) => error instanceof LocalH3Error && error.type === "local_job_not_found");
    assert.throws(() => getLocalVideoStatus(active.id, otherWorkspace),
      (error) => error instanceof LocalH3Error && error.type === "local_job_not_found");
    await discardLocalH3Workspace(otherWorkspace);
    await assert.rejects(readFile(otherReference.path), { code: "ENOENT" });
    assert.deepEqual(await readFile(reference.path), png);
    assert.equal(getLocalVideoStatus(active.id, workspaceToken).status, "processing");
    assert.deepEqual(await deleteLocalVideoJob(active.id, workspaceToken), { deleted: true });
    assert.throws(
      () => getLocalVideoStatus(active.id, workspaceToken),
      (error) => error instanceof LocalH3Error && error.type === "local_job_not_found",
    );

    const failed = await generateLocalVideo(input("fail"), workspaceToken);
    await waitFor(() => getLocalVideoStatus(failed.id, workspaceToken).status === "failed");
    assert.equal(getLocalVideoStatus(failed.id, workspaceToken).error, "Local h3.c generation failed.");
    await deleteLocalVideoJob(failed.id, workspaceToken);
    assert.ok(!(await readdir(jobsDirectory)).includes(failed.id));

    const completed = await generateLocalVideo(input("complete"), workspaceToken);
    await waitFor(() => getLocalVideoStatus(completed.id, workspaceToken).status === "completed");
    assert.deepEqual(await deleteLocalVideoJob(completed.id, workspaceToken), { deleted: true });
    assert.equal((await readdir(jobsDirectory)).some((entry) => entry.startsWith("local_")), false);
    await discardLocalH3Workspace(workspaceToken);
    await assert.rejects(readFile(reference.path), { code: "ENOENT" });
    assert.deepEqual(await readFile(manualReference), png);
  } finally {
    await shutdownLocalH3Storage();
    if (previous.binary === undefined) delete process.env.H3_BINARY;
    else process.env.H3_BINARY = previous.binary;
    if (previous.jobs === undefined) delete process.env.H3_JOBS_DIR;
    else process.env.H3_JOBS_DIR = previous.jobs;
    if (previous.model === undefined) delete process.env.H3_MODEL_DIR;
    else process.env.H3_MODEL_DIR = previous.model;
    if (previous.runtime === undefined) delete process.env.H3_RUNTIME_DIR;
    else process.env.H3_RUNTIME_DIR = previous.runtime;
    if (previous.ffprobe === undefined) delete process.env.H3_FFPROBE;
    else process.env.H3_FFPROBE = previous.ffprobe;
    if (previous.ffmpeg === undefined) delete process.env.H3_FFMPEG;
    else process.env.H3_FFMPEG = previous.ffmpeg;
    await rm(directory, { recursive: true, force: true });
  }
});
