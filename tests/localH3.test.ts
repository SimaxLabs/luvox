import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteLocalVideoJob,
  generateLocalVideo,
  getLocalVideoStatus,
  initializeLocalH3Storage,
  LocalH3Error,
  shutdownLocalH3Storage,
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

test("local h3.c jobs can be aborted and completed output can be deleted", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-h3-test-"));
  const jobsDirectory = path.join(directory, "jobs");
  const modelDirectory = path.join(directory, "model");
  const binary = path.join(directory, "fake-h3");
  const started = path.join(directory, "started");
  const previous = {
    binary: process.env.H3_BINARY,
    jobs: process.env.H3_JOBS_DIR,
    model: process.env.H3_MODEL_DIR,
    runtime: process.env.H3_RUNTIME_DIR,
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
  process.env.H3_BINARY = binary;
  process.env.H3_JOBS_DIR = jobsDirectory;
  process.env.H3_MODEL_DIR = modelDirectory;
  process.env.H3_RUNTIME_DIR = directory;

  try {
    await initializeLocalH3Storage();
    const workspaceToken = crypto.randomUUID();
    const active = await generateLocalVideo(input("wait"), workspaceToken);
    await waitFor(async () => (await readdir(directory)).includes("started"));
    await waitFor(() => getLocalVideoStatus(active.id, workspaceToken).phase === "Generating video");
    assert.deepEqual(await deleteLocalVideoJob(active.id, workspaceToken), { deleted: true });
    assert.throws(
      () => getLocalVideoStatus(active.id, workspaceToken),
      (error) => error instanceof LocalH3Error && error.type === "local_job_not_found",
    );

    const failed = await generateLocalVideo(input("fail"), workspaceToken);
    await waitFor(() => getLocalVideoStatus(failed.id, workspaceToken).status === "failed");
    assert.equal(getLocalVideoStatus(failed.id, workspaceToken).error, "Local h3.c generation failed.");
    await deleteLocalVideoJob(failed.id, workspaceToken);

    const completed = await generateLocalVideo(input("complete"), workspaceToken);
    await waitFor(() => getLocalVideoStatus(completed.id, workspaceToken).status === "completed");
    assert.deepEqual(await deleteLocalVideoJob(completed.id, workspaceToken), { deleted: true });
    assert.equal((await readdir(jobsDirectory)).some((entry) => entry.startsWith("local_")), false);
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
    await rm(directory, { recursive: true, force: true });
  }
});
