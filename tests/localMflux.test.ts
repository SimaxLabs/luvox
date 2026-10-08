import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { generateLocalMfluxImage, initializeLocalMfluxStorage, LocalMfluxError, shutdownLocalMflux } from "../server/localMflux.js";
import { MFLUX_WORKER_SOURCE } from "../server/mfluxWorker.js";
import { validateGenerateImageInput, type LocalMfluxGenerateImageInput } from "../server/validation.js";
import type { LocalMfluxProgress } from "../shared/imageTypes.js";

const referenceImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const webpReferenceImage = "data:image/webp;base64,UklGRlAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAASFZQOCAoAAAAcAEAnQEqAQABAAIANCWgAnQBQAAA/vgyy/9ej//zK//+ZX/Fz0IAAA==";
const input = (overrides: Partial<LocalMfluxGenerateImageInput> = {}): LocalMfluxGenerateImageInput => ({
  provider: "mflux",
  model: "flux2-klein-4b",
  prompt: "test image",
  resolution: "1024x1024",
  steps: 4,
  quantization: 8,
  lowRam: false,
  vaeTiling: false,
  vaeTileSize: 512,
  referenceFit: "contain",
  ...overrides,
});

test("MFLUX startup removes only stale owner-marked directories", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luvox-mflux-cleanup-test-"));
  const previousTemporaryDirectory = process.env.TMPDIR;
  const orphanPids: number[] = [];
  process.env.TMPDIR = temporaryRoot;
  try {
    const stale = path.join(temporaryRoot, "luvox-mflux-stale");
    const orphaned = path.join(temporaryRoot, "luvox-mflux-orphaned");
    const worker = path.join(temporaryRoot, "luvox-mflux-worker");
    const live = path.join(temporaryRoot, "luvox-mflux-live");
    const unmarked = path.join(temporaryRoot, "luvox-mflux-unmarked");
    await Promise.all([mkdir(stale), mkdir(orphaned), mkdir(worker), mkdir(live), mkdir(unmarked)]);
    const orphanPrompt = path.join(orphaned, "prompt.txt");
    await writeFile(orphanPrompt, "test");
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", orphanPrompt], {
      detached: true,
      stdio: "ignore",
    });
    assert.ok(orphan.pid);
    orphanPids.push(orphan.pid);
    const orphanWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(worker, "worker.py")], {
      detached: true,
      stdio: "ignore",
    });
    assert.ok(orphanWorker.pid);
    orphanPids.push(orphanWorker.pid);
    await Promise.all([
      writeFile(path.join(stale, ".luvox-owned"), `${JSON.stringify({ kind: "luvox-mflux-request", version: 1, pid: 2_147_483_647, binary: process.execPath })}\n`),
      writeFile(path.join(orphaned, ".luvox-owned"), `${JSON.stringify({ kind: "luvox-mflux-request", version: 1, pid: 2_147_483_647, binary: process.execPath })}\n`),
      writeFile(path.join(worker, ".luvox-owned"), `${JSON.stringify({ kind: "luvox-mflux-worker", version: 1, pid: 2_147_483_647, binary: process.execPath })}\n`),
      writeFile(path.join(live, ".luvox-owned"), `${JSON.stringify({ kind: "luvox-mflux-request", version: 1, pid: process.pid, binary: process.execPath })}\n`),
    ]);

    await initializeLocalMfluxStorage();
    assert.deepEqual((await readdir(temporaryRoot)).sort(), ["luvox-mflux-live", "luvox-mflux-unmarked"]);
    await assert.rejects(
      generateLocalMfluxImage(input({
        resolution: "1280x720",
        steps: 3,
        quantization: null,
      })),
      (error) => error instanceof LocalMfluxError && error.type === "local_mflux_unavailable",
    );
  } finally {
    for (const orphanPid of orphanPids) {
      try {
        process.kill(-orphanPid, "SIGKILL");
      } catch {
        // Startup cleanup should already have stopped the fake orphan.
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    await mkdir(temporaryRoot);
    await initializeLocalMfluxStorage();
    await rm(temporaryRoot, { recursive: true, force: true });
    if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporaryDirectory;
  }
});

test("MFLUX validation enforces shared presets and advanced ranges", () => {
  assert.throws(() => validateGenerateImageInput(input({
    resolution: "1920x1080",
  })));
  assert.throws(() => validateGenerateImageInput(input({
    model: "schnell",
  })));
  assert.throws(() => validateGenerateImageInput(input({
    steps: 5,
  })));
  assert.throws(() => validateGenerateImageInput(input({
    vaeTiling: true,
    vaeTileSize: 1024,
  })));
  assert.throws(() => validateGenerateImageInput(input({
    model: "qwen-image-edit",
    steps: 20,
    inputReference: referenceImage,
  })));
  assert.throws(() => validateGenerateImageInput(input({
    model: "z-image-turbo",
    steps: 20,
  })));
  assert.throws(() => validateGenerateImageInput({ ...input({ model: "z-image-turbo", steps: 9 }), guidance: 3 }));
  assert.throws(() => validateGenerateImageInput(input({ steps: 9 })));
  for (const steps of [4, 6, 9]) {
    for (const reference of [undefined, referenceImage]) {
      assert.doesNotThrow(() => validateGenerateImageInput(input({ model: "z-image-turbo", steps, inputReference: reference })));
    }
  }
});

test("MFLUX adapter returns and cleans a generated raster", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-mflux-test-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luvox-mflux-output-test-"));
  const binary = path.join(directory, "mflux-generate-flux2");
  const zImageBinary = path.join(directory, "mflux-generate-z-image-turbo");
  const editDirectory = path.join(directory, "bin");
  const editBinary = path.join(editDirectory, "mflux-generate-flux2-edit");
  const previousFlux2Binary = process.env.MFLUX_FLUX2_BINARY;
  const previousZImageBinary = process.env.MFLUX_Z_IMAGE_TURBO_BINARY;
  const previousTemporaryDirectory = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  const fakeBinary = `#!/usr/bin/env node
const { readFileSync, readdirSync, statSync, truncateSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename, dirname } = require("node:path");
const output = process.argv[process.argv.indexOf("--output") + 1];
const prompt = readFileSync(process.argv[process.argv.indexOf("--prompt-file") + 1], "utf8");
for (const argument of ["--model", "--prompt-file", "--steps", "--width", "--height"]) {
  if (!process.argv.includes(argument)) process.exit(2);
}
const model = process.argv[process.argv.indexOf("--model") + 1];
if (model !== "flux2-klein-4b" && model !== "z-image-turbo") process.exit(2);
let steps = Number(process.argv[process.argv.indexOf("--steps") + 1]);
const referenceIndex = process.argv.indexOf(model === "z-image-turbo" ? "--image-path" : "--image-paths");
if (model === "z-image-turbo") {
  if (basename(process.argv[1]) !== "mflux-generate-z-image-turbo" || process.argv.includes("--guidance") || process.argv.includes("--image-paths")) process.exit(2);
  if (referenceIndex >= 0) {
    if (process.argv[process.argv.indexOf("--image-strength") + 1] !== "0.4") process.exit(2);
    steps -= Math.max(1, Math.floor(steps * 0.4));
  } else if (process.argv.includes("--image-strength")) process.exit(2);
}
if (referenceIndex >= 0) {
  if (readdirSync(dirname(process.argv[referenceIndex + 1])).some((name) => /^reference\\.(?:jpg|png|webp)$/.test(name))) process.exit(2);
  const referenceInfo = spawnSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", process.argv[referenceIndex + 1]], { encoding: "utf8" });
  const width = process.argv[process.argv.indexOf("--width") + 1];
  const height = process.argv[process.argv.indexOf("--height") + 1];
  if (referenceInfo.status !== 0 || !referenceInfo.stdout.includes("pixelWidth: " + width) || !referenceInfo.stdout.includes("pixelHeight: " + height)) process.exit(2);
}
process.stderr.write("  0%|          | 0/" + steps + " [00:00<?, ?it/s]\\r");
process.stderr.write(" 50%|#####     | " + Math.floor(steps / 2) + "/" + steps + " [00:20<00:20, 2.00s/it]\\r");
process.stderr.write("100%|##########| " + steps + "/" + steps + " [00:40<00:00, 2.00s/it]\\r");
if (prompt === "wait") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
if (prompt === "test image") {
  for (const argument of ["3", "--seed", "42", "--low-ram", "--vae-tiling", "--vae-tile-size", "256", "--image-paths"]) {
    if (!process.argv.includes(argument)) process.exit(2);
  }
  if (basename(process.argv[1]) !== "mflux-generate-flux2-edit" || process.argv.includes("--quantize") || process.argv.includes("--image-strength")) process.exit(2);
}
if (prompt === "invalid output" && basename(process.argv[1]) !== "mflux-generate-flux2") process.exit(2);
const width = process.argv[process.argv.indexOf("--width") + 1];
const height = process.argv[process.argv.indexOf("--height") + 1];
writeFileSync(output, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const resizeStatus = spawnSync("/usr/bin/sips", ["-z", height, width, output], { stdio: "ignore" }).status || 0;
if (prompt === "invalid output") truncateSync(output, Math.floor(statSync(output).size / 2));
process.exit(resizeStatus);
}
`;
  await mkdir(editDirectory);
  await Promise.all([binary, editBinary, zImageBinary].map((file) => writeFile(file, fakeBinary)));
  await Promise.all([binary, editBinary, zImageBinary].map((file) => chmod(file, 0o700)));
  process.env.MFLUX_FLUX2_BINARY = binary;
  process.env.MFLUX_Z_IMAGE_TURBO_BINARY = zImageBinary;
  process.env.TMPDIR = temporaryRoot;
  process.env.PATH = `${editDirectory}${path.delimiter}${previousPath || ""}`;

  try {
    const result = await generateLocalMfluxImage(input({
      resolution: "1280x720",
      steps: 3,
      quantization: null,
      seed: 42,
      lowRam: true,
      vaeTileSize: 256,
      referenceFit: "cover",
      inputReference: referenceImage,
    }));
    assert.equal(result.mediaType, "image/png");
    assert.ok(result.b64Json.startsWith("iVBOR"));
    for (const reference of [undefined, referenceImage, webpReferenceImage]) {
      const progress: LocalMfluxProgress[] = [];
      const zImageResult = await generateLocalMfluxImage(input({
        model: "z-image-turbo",
        prompt: "image variation",
        resolution: "1280x720",
        steps: 9,
        inputReference: reference,
      }), undefined, (update) => progress.push(update));
      assert.equal(zImageResult.mediaType, "image/png");
      const total = reference ? 6 : 9;
      assert.ok(progress.some((update) => update.phase === "generating" && update.step === Math.floor(total / 2) && update.total === total && update.etaSeconds === 20 && update.secondsPerStep === 2));
      assert.equal(progress.at(-1)?.phase, "decoding");
      assert.deepEqual(await readdir(temporaryRoot), []);
    }
    const webpResult = await generateLocalMfluxImage(input({
      prompt: "webp reference",
      inputReference: webpReferenceImage,
    }));
    assert.equal(webpResult.mediaType, "image/png");
    const preprocessingController = new AbortController();
    const preprocessing = generateLocalMfluxImage(input({
      resolution: "1280x720",
      steps: 3,
      quantization: null,
      inputReference: referenceImage,
    }), preprocessingController.signal);
    setTimeout(() => preprocessingController.abort(), 1);
    await assert.rejects(
      preprocessing,
      (error) => error instanceof LocalMfluxError && error.type === "local_mflux_aborted",
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = generateLocalMfluxImage(input({
      prompt: "wait",
    }), controller.signal, (update) => {
      if (update.phase === "generating") markStarted();
    });
    await started;
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof LocalMfluxError && error.type === "local_mflux_aborted",
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
    await assert.rejects(
      generateLocalMfluxImage(input({
        prompt: "invalid output",
      })),
      (error) => error instanceof LocalMfluxError && error.type === "local_mflux_output_error",
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    if (previousFlux2Binary === undefined) delete process.env.MFLUX_FLUX2_BINARY;
    else process.env.MFLUX_FLUX2_BINARY = previousFlux2Binary;
    if (previousZImageBinary === undefined) delete process.env.MFLUX_Z_IMAGE_TURBO_BINARY;
    else process.env.MFLUX_Z_IMAGE_TURBO_BINARY = previousZImageBinary;
    if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporaryDirectory;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("MFLUX warm worker reuses weights, isolates requests, and releases memory on lifecycle changes", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-warm-test-"));
  const temporaryRoot = path.join(directory, "jobs");
  const python = path.join(directory, "python3");
  const cliBinary = path.join(directory, "mflux-cli");
  const binary = path.join(directory, "mflux-generate-flux2");
  const editBinary = path.join(directory, "mflux-generate-flux2-edit");
  const zImageBinary = path.join(directory, "mflux-generate-z-image-turbo");
  const names = ["MFLUX_FLUX2_BINARY", "MFLUX_Z_IMAGE_TURBO_BINARY", "MFLUX_KEEP_ALIVE_MINUTES", "TMPDIR", "OPENROUTER_API_KEY"];
  const previous = names.map((name) => process.env[name]);
  const events = async (): Promise<Array<Record<string, any>>> => (await readFile(path.join(directory, "python3.events"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const request = (overrides: Partial<LocalMfluxGenerateImageInput> = {}) => generateLocalMfluxImage(input({ prompt: "first", seed: 42, ...overrides }));
  const assertIdleFiles = async () => {
    const entries = await readdir(temporaryRoot);
    assert.equal(entries.length, 1);
    assert.deepEqual((await readdir(path.join(temporaryRoot, entries[0]))).sort(), [".luvox-owned", "worker.py"]);
  };

  try {
    await mkdir(temporaryRoot);
    const fixture = await readFile(new URL("./fixtures/mfluxPython.py", import.meta.url));
    await Promise.all([python, cliBinary].map((file) => writeFile(file, fixture, { mode: 0o700 })));
    await Promise.all([
      [binary, "flux2.cli.flux2_generate"],
      [editBinary, "flux2.cli.flux2_edit_generate"],
      [zImageBinary, "z_image.cli.z_image_turbo_generate"],
    ].map(([file, module]) => writeFile(file, `#!${python}\nimport sys\nfrom mflux.models.${module} import main\nif __name__ == "__main__":\n    sys.exit(main())\n`, { mode: 0o700 })));
    await writeFile(binary, `#!${python}\n# -*- coding: utf-8 -*-\nimport sys\nfrom mflux.models.flux2.cli.flux2_generate import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())\n`);
    await writeFile(editBinary, `#!${python}\n# -*- coding: utf-8 -*-\nimport re\nimport sys\nfrom mflux.models.flux2.cli.flux2_edit_generate import main\nif __name__ == '__main__':\n    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n    sys.exit(main())\n`);
    process.env.MFLUX_FLUX2_BINARY = binary;
    process.env.MFLUX_Z_IMAGE_TURBO_BINARY = zImageBinary;
    process.env.MFLUX_KEEP_ALIVE_MINUTES = "5";
    process.env.TMPDIR = temporaryRoot;
    process.env.OPENROUTER_API_KEY = "must-not-reach-worker";

    assert.equal((await request()).mediaType, "image/png");
    await assertIdleFiles();
    await request({ prompt: "second", seed: 7, steps: 2, resolution: "1280x720" });
    let history = await events();
    assert.equal(history.filter((event) => event.event === "load").length, 1);
    const generations = history.filter((event) => event.event === "generate");
    assert.deepEqual(generations.map((event) => [event.prompt, event.seed, event.width, event.num_inference_steps]), [["first", 42, 1024, 4], ["second", 7, 1280, 2]]);
    assert.equal(generations[0].pid, generations[1].pid);
    await assertIdleFiles();

    await request({ quantization: 4, vaeTiling: true, vaeTileSize: 256 });
    history = await events();
    assert.equal(history.filter((event) => event.event === "load").length, 2);
    assert.equal(history.at(-1)?.tile.vae_decode_tile_size, 256);
    assert.notEqual(history.at(-1)?.pid, generations[0].pid);
    assert.throws(() => process.kill(generations[0].pid, 0), { code: "ESRCH" });

    await request({ inputReference: referenceImage });
    assert.equal((await events()).filter((event) => event.event === "load").at(-1)?.pipeline, "Flux2KleinEdit");
    await request({ model: "z-image-turbo", steps: 9, inputReference: referenceImage });
    history = await events();
    assert.equal(history.filter((event) => event.event === "load").at(-1)?.pipeline, "ZImage");
    assert.equal(history.filter((event) => event.event === "load").at(-1)?.model_config, "z-image-turbo");
    assert.equal(history.at(-1)?.guidance, 0);
    assert.equal(history.at(-1)?.image_strength, 0.4);
    assert.ok(history.at(-1)?.image_path.endsWith("reference-framed.png"));
    const zImagePid = history.at(-1)?.pid;
    const loadCount = history.filter((event) => event.event === "load").length;
    await request({ model: "z-image-turbo", steps: 6, prompt: "another image" });
    history = await events();
    assert.equal(history.at(-1)?.pid, zImagePid);
    assert.equal(history.filter((event) => event.event === "load").length, loadCount);
    assert.equal(history.at(-1)?.image_path, null);
    assert.equal(history.at(-1)?.num_inference_steps, 6);
    assert.equal(history.at(-1)?.scheduler, "linear");
    await assertIdleFiles();

    process.env.MFLUX_FLUX2_BINARY = cliBinary;
    await request({ lowRam: true });
    assert.ok((await readFile(path.join(directory, "mflux-cli.events"), "utf8")).includes('"low_ram": true'));
    assert.deepEqual(await readdir(temporaryRoot), []);
    await request(); // A custom Python wrapper must also use the CLI with reuse enabled.
    assert.deepEqual(await readdir(temporaryRoot), []);
    process.env.MFLUX_KEEP_ALIVE_MINUTES = "0";
    await request();
    assert.ok((await readFile(path.join(directory, "mflux-cli.events"), "utf8")).includes('"low_ram": false'));
    assert.deepEqual(await readdir(temporaryRoot), []);
    process.env.MFLUX_KEEP_ALIVE_MINUTES = "5";
    process.env.MFLUX_FLUX2_BINARY = binary;

    for (const prompt of ["fail", "exit", "invalid output"]) {
      await assert.rejects(request({ prompt }), (error) => error instanceof LocalMfluxError && !error.message.includes("private prompt"));
      assert.deepEqual(await readdir(temporaryRoot), []);
    }

    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = generateLocalMfluxImage(input({ prompt: "wait" }), controller.signal, (progress) => {
      if (progress.phase === "generating") markStarted();
    });
    await started;
    await assert.rejects(request(), (error) => error instanceof LocalMfluxError && error.type === "local_mflux_busy");
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof LocalMfluxError && error.type === "local_mflux_aborted");
    assert.deepEqual(await readdir(temporaryRoot), []);

    process.env.MFLUX_KEEP_ALIVE_MINUTES = "0.02";
    await request();
    for (let attempt = 0; attempt < 40 && (await readdir(temporaryRoot)).length; attempt += 1) await delay(100);
    assert.deepEqual(await readdir(temporaryRoot), []);

    process.env.MFLUX_KEEP_ALIVE_MINUTES = "5";
    await request();
    const idlePid = (await events()).at(-1)!.pid;
    process.kill(idlePid, "SIGKILL");
    for (let attempt = 0; attempt < 30 && (await readdir(temporaryRoot)).length; attempt += 1) await delay(50);
    assert.deepEqual(await readdir(temporaryRoot), []);
    await request();
    assert.notEqual((await events()).at(-1)?.pid, idlePid);
    await shutdownLocalMflux();
    assert.deepEqual(await readdir(temporaryRoot), []);

    // A worker must also stop mid-generation if its parent vanishes without closing stdin.
    const script = path.join(directory, "worker.py");
    const prompt = path.join(directory, "prompt.txt");
    await writeFile(script, MFLUX_WORKER_SOURCE);
    await writeFile(prompt, "wait");
    const orphan = spawn(python, ["-u", "-B", script, binary, "flux2", "2147483647"], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const closed = new Promise<number | null>((resolve) => orphan.once("close", resolve));
    let startedGenerating = false;
    orphan.stderr.on("data", (chunk) => { if (chunk.toString().includes("50%")) startedGenerating = true; });
    const killTimer = setTimeout(() => orphan.kill("SIGKILL"), 5_000);
    try {
      orphan.stdin.write(`${JSON.stringify(["--model", "flux2-klein-4b", "--prompt-file", prompt, "--output", path.join(directory, "unused.png"), "--steps", "4", "--width", "1024", "--height", "1024"])}\n`);
      assert.equal(await closed, 1);
      assert.equal(startedGenerating, true);
    } finally {
      clearTimeout(killTimer);
      orphan.kill("SIGKILL");
    }
  } finally {
    await shutdownLocalMflux();
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
});
