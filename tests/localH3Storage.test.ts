import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const supported = process.platform === "darwin" && process.arch === "arm64";

async function storageProcess(t: TestContext, directory: string, generate = false) {
  const child = fork(new URL("./fixtures/h3Storage.ts", import.meta.url), generate ? ["generate"] : [], {
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: directory, HOST: "127.0.0.1",
      OPENROUTER_API_KEY: "", H3_JOBS_DIR: path.join(directory, "jobs"),
      H3_BINARY: path.join(directory, "fake-h3"), H3_MODEL_DIR: directory, H3_RUNTIME_DIR: directory,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => { diagnostics += chunk; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send("shutdown");
    else child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(forceKill);
  });
  const result = await Promise.race([
    once(child, "message").then(([message]) => message as { ready?: boolean; jobId?: string; error?: string; message?: string }),
    exited.then(() => { throw new Error(`Storage fixture exited before reporting: ${diagnostics}`); }),
  ]);
  return { child, exited, result };
}

test("h3.c refuses a live owner, recovers a crashed owner and engine, and preserves unrelated files", {
  skip: !supported, timeout: 20_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-h3-recovery-"));
  const jobs = path.join(directory, "jobs");
  const started = path.join(directory, "engine-pid");
  let enginePid: number | undefined;
  try {
    await writeFile(path.join(directory, "h3_shaders.metal"), "fake shader");
    await writeFile(path.join(directory, "fake-h3"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(started)}, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const owner = await storageProcess(t, directory, true);
    assert.equal(owner.result.ready, true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      enginePid = Number(await readFile(started, "utf8").catch(() => "")) || undefined;
      if (enginePid) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(enginePid, "Fake engine did not start");
    const lockPath = path.join(jobs, ".luvox.lock", "owner.json");
    const lock = await readFile(lockPath, "utf8");
    assert.equal(JSON.parse(lock).activeGroups[0].pid, enginePid);
    const contender = await storageProcess(t, directory);
    assert.equal(contender.result.error, "local_storage_locked");
    await contender.exited;
    assert.equal(await readFile(lockPath, "utf8"), lock);
    assert.ok((await readdir(jobs)).includes(owner.result.jobId!));

    const references = path.join(jobs, "reference-images");
    await mkdir(references);
    const staleReference = path.join(references, `${crypto.randomUUID()}.png`);
    await writeFile(staleReference, "stale upload");
    const preserved = [
      path.join(jobs, "notes.txt"), path.join(jobs, "local_notes", "keep.txt"),
      path.join(jobs, ".luvox.lock.stale-0-0"), path.join(references, "manual.png"),
      path.join(directory, "source.png"),
    ];
    await mkdir(path.join(jobs, "local_notes"));
    for (const file of preserved) await writeFile(file, "keep this file");
    const linkedReference = path.join(references, `${crypto.randomUUID()}.png`);
    await symlink(path.join(directory, "source.png"), linkedReference);

    owner.child.kill("SIGKILL");
    await owner.exited;
    assert.doesNotThrow(() => process.kill(enginePid!, 0), "Crash must leave a fake engine to recover");
    const recovered = await storageProcess(t, directory);
    assert.equal(recovered.result.ready, true, recovered.result.message);
    assert.throws(() => process.kill(enginePid!, 0), { code: "ESRCH" });
    enginePid = undefined;
    assert.ok(!(await readdir(jobs)).includes(owner.result.jobId!));
    await assert.rejects(readFile(staleReference), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, recovered.child.pid);
    recovered.child.send("shutdown");
    assert.deepEqual(await recovered.exited, [0, null]);
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
    for (const file of [...preserved, linkedReference]) assert.equal(await readFile(file, "utf8"), "keep this file");
  } finally {
    if (enginePid) {
      try { process.kill(-enginePid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
    // Stop fixture servers before removing the storage they own, including on assertion failure.
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
});

test("h3.c refuses an unmarked nonempty directory without deleting its contents", {
  skip: !supported, timeout: 10_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-h3-unowned-"));
  try {
    const job = path.join(directory, "jobs", `local_${crypto.randomUUID()}`);
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, "video.mp4"), "unrelated video");
    const unowned = await storageProcess(t, directory);
    assert.equal(unowned.result.error, "local_storage_ownership_error");
    await unowned.exited;
    assert.equal(await readFile(path.join(job, "video.mp4"), "utf8"), "unrelated video");
    assert.deepEqual(await readdir(path.join(directory, "jobs")), [path.basename(job)]);
  } finally {
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
});
