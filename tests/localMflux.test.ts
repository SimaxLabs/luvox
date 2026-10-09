import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { generateLocalMfluxImage, getAvailableLocalMfluxModels, initializeLocalMfluxStorage, LocalMfluxError, shutdownLocalMflux } from "../server/localMflux.js";
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
  assert.throws(() => validateGenerateImageInput(input({ model: "z-image-turbo" })), /Unsupported MFLUX model/);
  assert.throws(() => validateGenerateImageInput({ ...input(), guidance: 3 }));
  assert.throws(() => validateGenerateImageInput(input({ steps: 9 })));
  for (const model of ["flux2-klein-4b", "flux2-klein-9b"]) {
    for (const steps of [1, 2, 3, 4]) {
      for (const inputReference of [undefined, referenceImage]) {
        assert.doesNotThrow(() => validateGenerateImageInput(input({ model, steps, inputReference })));
      }
    }
    assert.throws(() => validateGenerateImageInput(input({ model, steps: 9 })));
    assert.throws(() => validateGenerateImageInput({ ...input({ model }), referenceStrength: 0.4 }));
    assert.throws(() => validateGenerateImageInput({ ...input({ model }), loras: [{ source: "example/style", scale: 1 }] }));
    assert.doesNotThrow(() => validateGenerateImageInput(input({ model, inputReference: referenceImage, generateMissing: true })));
    assert.throws(() => validateGenerateImageInput(input({ model, generateMissing: true })));
    assert.throws(() => validateGenerateImageInput(input({ model, inputReference: referenceImage, referenceFit: "cover", generateMissing: true })));
  }
  assert.throws(() => validateGenerateImageInput({ ...input({ inputReference: referenceImage }), generateMissing: "true" }));
});

test("MFLUX adapter returns and cleans a generated raster", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-mflux-test-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luvox-mflux-output-test-"));
  const binary = path.join(directory, "mflux-generate-flux2");
  const editDirectory = path.join(directory, "bin");
  const editBinary = path.join(editDirectory, "mflux-generate-flux2-edit");
  const previousFlux2Binary = process.env.MFLUX_FLUX2_BINARY;
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
if (!["flux2-klein-4b", "flux2-klein-9b"].includes(model)) process.exit(2);
const steps = Number(process.argv[process.argv.indexOf("--steps") + 1]);
const referenceIndex = process.argv.indexOf("--image-paths");
if (prompt === "9b image" && model !== "flux2-klein-9b") process.exit(2);
const expected = referenceIndex >= 0 ? "mflux-generate-flux2-edit" : "mflux-generate-flux2";
if (basename(process.argv[1]) !== expected || process.argv.includes("--image-strength") || process.argv.includes("--image-path")) process.exit(2);
if (referenceIndex >= 0) {
  if (readdirSync(dirname(process.argv[referenceIndex + 1])).some((name) => /^reference\\.(?:jpg|png|webp)$/.test(name))) process.exit(2);
  const referenceInfo = spawnSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", process.argv[referenceIndex + 1]], { encoding: "utf8" });
  let width = process.argv[process.argv.indexOf("--width") + 1];
  let height = process.argv[process.argv.indexOf("--height") + 1];
  const outpaint = /^outpaint-(horizontal|vertical|same-size)$/.exec(prompt.split("\\n\\n")[0]);
  if (outpaint && outpaint[1] !== "same-size") {
    width = height = "720";
    const sides = outpaint[1] === "horizontal" ? "left and right" : "top and bottom";
    if (!prompt.includes("Canvas extension:") || !prompt.includes(sides) || !prompt.includes("instead of black bars")) process.exit(2);
  } else if (outpaint && prompt !== "outpaint-same-size") process.exit(2);
  if (referenceInfo.status !== 0 || !referenceInfo.stdout.includes("pixelWidth: " + width) || !referenceInfo.stdout.includes("pixelHeight: " + height)) process.exit(2);
}
if (prompt.startsWith("download")) {
  process.stderr.write("Downloading model from HuggingFace: private/model...\\n");
  process.stderr.write("Fetching 4 files:  50%|#####     | 2/4 [00:20<00:20, 2.00s/it]\\r");
  if (prompt === "download access") {
    process.stderr.write("GatedRepoError: hf_secret /private/cache https://private.example/model\\n");
    process.exit(1);
  }
  process.stderr.write("Fetching 4 files: 100%|##########| 4/4 [00:40<00:00, 2.00s/it]\\r");
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
  await Promise.all([binary, editBinary].map((file) => writeFile(file, fakeBinary)));
  await Promise.all([binary, editBinary].map((file) => chmod(file, 0o700)));
  process.env.MFLUX_FLUX2_BINARY = binary;
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
    assert.deepEqual(getAvailableLocalMfluxModels(), ["flux2-klein-4b", "flux2-klein-9b"]);
    for (const inputReference of [undefined, referenceImage]) {
      const progress: LocalMfluxProgress[] = [];
      const nineB = await generateLocalMfluxImage(input({ model: "flux2-klein-9b", prompt: "9b image", inputReference }), undefined, (update) => progress.push(update));
      assert.equal(nineB.mediaType, "image/png");
      assert.deepEqual(progress[0], { phase: "loading", step: 0, total: 4, percent: 0 });
      assert.ok(progress.every((update) => update.total === 4));
      assert.ok(progress.some((update) => update.phase === "generating" && update.step === 2 && update.etaSeconds === 20 && update.secondsPerStep === 2));
      assert.equal(progress.at(-1)?.step, 4);
      assert.equal(progress.at(-1)?.phase, "decoding");
      assert.deepEqual(await readdir(temporaryRoot), []);
    }
    for (const model of ["flux2-klein-4b", "flux2-klein-9b"]) {
      for (const [resolution, prompt] of [["1280x720", "outpaint-horizontal"], ["720x1280", "outpaint-vertical"], ["1024x1024", "outpaint-same-size"]]) {
        const expanded = await generateLocalMfluxImage(input({ model, resolution, prompt, inputReference: referenceImage, generateMissing: true }));
        assert.equal(expanded.mediaType, "image/png");
        assert.deepEqual(await readdir(temporaryRoot), []);
      }
    }
    const webpResult = await generateLocalMfluxImage(input({
      prompt: "webp reference",
      inputReference: webpReferenceImage,
    }));
    assert.equal(webpResult.mediaType, "image/png");
    const downloadProgress: LocalMfluxProgress[] = [];
    await generateLocalMfluxImage(input({ prompt: "download" }), undefined, (progress) => downloadProgress.push(progress));
    assert.ok(downloadProgress.some((progress) => progress.phase === "downloading" && progress.download?.completed === 2));
    assert.equal(downloadProgress.filter((progress) => progress.phase === "generating" && progress.step === 2).length, 1);
    await assert.rejects(generateLocalMfluxImage(input({ prompt: "download access" })), (error) =>
      error instanceof LocalMfluxError && error.type === "local_mflux_access_error" && !error.message.includes("hf_secret"));
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
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luvox-warm-test-"));
  const temporaryRoot = path.join(directory, "jobs");
  const python = path.join(directory, "python3");
  const cliBinary = path.join(directory, "mflux-cli");
  const binary = path.join(directory, "mflux-generate-flux2");
  const editBinary = path.join(directory, "mflux-generate-flux2-edit");
  const names = ["MFLUX_FLUX2_BINARY", "MFLUX_KEEP_ALIVE_MINUTES", "MFLUX_TIMEOUT_MINUTES", "MFLUX_DOWNLOAD_TIMEOUT_MINUTES", "TMPDIR", "OPENROUTER_API_KEY"];
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
    ].map(([file, module]) => writeFile(file, `#!${python}\nimport sys\nfrom mflux.models.${module} import main\nif __name__ == "__main__":\n    sys.exit(main())\n`, { mode: 0o700 })));
    await writeFile(binary, `#!${python}\n# -*- coding: utf-8 -*-\nimport sys\nfrom mflux.models.flux2.cli.flux2_generate import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())\n`);
    await writeFile(editBinary, `#!${python}\n# -*- coding: utf-8 -*-\nimport re\nimport sys\nfrom mflux.models.flux2.cli.flux2_edit_generate import main\nif __name__ == '__main__':\n    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n    sys.exit(main())\n`);
    process.env.MFLUX_FLUX2_BINARY = binary;
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
    let previousPid = (await events()).at(-1)!.pid;
    for (const [model, inputReference, pipeline] of [
      ["flux2-klein-9b", referenceImage, "Flux2KleinEdit"],
      ["flux2-klein-9b", undefined, "Flux2Klein"],
      ["flux2-klein-4b", undefined, "Flux2Klein"],
    ] as const) {
      await request({ model, inputReference });
      history = await events();
      const loaded = history.filter((event) => event.event === "load").at(-1)!;
      assert.equal(loaded.model_config, model);
      assert.equal(loaded.pipeline, pipeline);
      assert.notEqual(loaded.pid, previousPid);
      assert.throws(() => process.kill(previousPid, 0), { code: "ESRCH" });
      assert.equal(history.at(-1)?.guidance, 1);
      assert.equal(history.at(-1)?.scheduler, "flow_match_euler_discrete");
      assert.equal(Boolean(history.at(-1)?.image_paths?.length), Boolean(inputReference));
      const loadCount = history.filter((event) => event.event === "load").length;
      await request({ model, inputReference, prompt: "second" });
      history = await events();
      assert.equal(history.at(-1)?.pid, loaded.pid);
      assert.equal(history.at(-1)?.prompt, "second");
      assert.equal(history.filter((event) => event.event === "load").length, loadCount);
      await assertIdleFiles();
      previousPid = loaded.pid;
    }
    await request({ prompt: "Extend this landscape", resolution: "1280x720", inputReference: referenceImage, generateMissing: true });
    history = await events();
    assert.equal(history.filter((event) => event.event === "load").at(-1)?.pipeline, "Flux2KleinEdit");
    assert.ok(history.at(-1)?.prompt.startsWith("Extend this landscape\n\nCanvas extension:"));
    assert.ok(history.at(-1)?.prompt.includes("left and right"));
    assert.equal(history.at(-1)?.width, 1280);
    assert.equal(history.at(-1)?.height, 720);
    await assertIdleFiles();
    for (const inputReference of [undefined, referenceImage]) {
      await request({ model: "flux2-klein-9b", inputReference, lowRam: true, resolution: "720x1280", generateMissing: Boolean(inputReference) });
      history = await events();
      const loaded = history.filter((event) => event.event === "load").at(-1)!;
      assert.equal(loaded.model_config, "flux2-klein-9b");
      assert.equal(loaded.pipeline, inputReference ? "Flux2KleinEdit" : "Flux2Klein");
      assert.equal(history.at(-1)?.low_ram, true);
      const generation = history.filter((event) => event.event === "generate").at(-1)!;
      assert.equal(generation.prompt.includes("Canvas extension:"), Boolean(inputReference));
      if (inputReference) assert.ok(generation.prompt.includes("top and bottom"));
      assert.deepEqual(await readdir(temporaryRoot), []);
    }
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

    process.env.MFLUX_KEEP_ALIVE_MINUTES = "0";
    process.env.MFLUX_TIMEOUT_MINUTES = "30";
    process.env.MFLUX_DOWNLOAD_TIMEOUT_MINUTES = "120";
    const cache = path.join(directory, "python3.cache");
    const mode = path.join(directory, "python3.mode");
    await rm(cache, { recursive: true, force: true });
    const downloadProgress: LocalMfluxProgress[] = [];
    await generateLocalMfluxImage(input({ prompt: "first", lowRam: true }), undefined, (progress) => downloadProgress.push(progress));
    assert.ok(downloadProgress.some((progress) => progress.phase === "checking"));
    assert.ok(downloadProgress.some((progress) => progress.phase === "downloading" && progress.download?.unit === "bytes" && progress.download.completed === 500_000 && progress.percent === 50));
    assert.equal((await events()).at(-1)?.low_ram, true);
    assert.deepEqual(await readdir(temporaryRoot), []);
    assert.equal((await readdir(cache)).length, 2);
    assert.ok(!JSON.stringify(downloadProgress).includes("private"));
    const cachedProgress: LocalMfluxProgress[] = [];
    await generateLocalMfluxImage(input({ prompt: "first" }), undefined, (progress) => cachedProgress.push(progress));
    assert.ok(!cachedProgress.some((progress) => progress.phase === "downloading"));

    for (const code of ["access", "network", "disk_full", "cache_permission", "resource_missing", "dependencies"]) {
      await rm(cache, { recursive: true, force: true });
      await writeFile(mode, code);
      await assert.rejects(request(), (error) => error instanceof LocalMfluxError &&
        error.type === `local_mflux_${code}_error` && !/hf_secret|private/.test(error.message));
      assert.deepEqual(await readdir(temporaryRoot), []);
    }

    await writeFile(mode, "stall");
    const downloadController = new AbortController();
    let markDownloading!: () => void;
    const downloading = new Promise<void>((resolve) => { markDownloading = resolve; });
    const interrupted = generateLocalMfluxImage(input({ prompt: "first" }), downloadController.signal, (progress) => {
      if (progress.phase === "downloading") markDownloading();
    });
    await downloading;
    await assert.rejects(request(), (error) => error instanceof LocalMfluxError && error.type === "local_mflux_busy");
    downloadController.abort();
    await assert.rejects(interrupted, (error) => error instanceof LocalMfluxError && error.type === "local_mflux_aborted");
    assert.deepEqual(await readdir(temporaryRoot), []);
    assert.ok((await readdir(cache)).some((file) => file.endsWith(".incomplete")));
    await writeFile(mode, "");
    await request();
    assert.equal((await readdir(cache)).length, 2);

    // Advance the host clock without slowing the fake engine or downloading real resources.
    for (const scenario of ["separate budgets", "download timeout", "generation timeout"]) {
      await rm(cache, { recursive: true, force: true });
      t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
      const clock = t.mock.method(performance, "now", () => Date.now());
      try {
        const operation = generateLocalMfluxImage(input({ prompt: "first" }), undefined, (progress) => {
          if (progress.phase === "checking" && scenario !== "generation timeout") {
            t.mock.timers.tick((scenario === "download timeout" ? 70 : 20) * 60_000);
          }
          if (progress.phase === "generating" && scenario === "generation timeout") {
            t.mock.timers.tick(31 * 60_000);
          }
        });
        if (scenario === "separate budgets") assert.equal((await operation).mediaType, "image/png");
        else await assert.rejects(operation, (error) => error instanceof LocalMfluxError && error.type ===
          (scenario === "download timeout" ? "local_mflux_download_timeout" : "local_mflux_timeout"));
        assert.deepEqual(await readdir(temporaryRoot), []);
      } finally {
        clock.mock.restore();
        t.mock.timers.reset();
      }
    }

    process.env.MFLUX_KEEP_ALIVE_MINUTES = "5";
    await request();
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
