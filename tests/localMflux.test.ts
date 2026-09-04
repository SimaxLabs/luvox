import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateLocalMfluxImage, LocalMfluxError } from "../server/localMflux.js";
import { validateGenerateImageInput } from "../server/validation.js";
import type { LocalMfluxProgress } from "../shared/imageTypes.js";

const referenceImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("MFLUX validation enforces shared presets and advanced ranges", () => {
  assert.throws(() => validateGenerateImageInput({
    provider: "mflux",
    model: "flux2-klein-4b",
    prompt: "test image",
    resolution: "1920x1080",
    steps: 4,
    quantization: 8,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
  }));
  assert.throws(() => validateGenerateImageInput({
    provider: "mflux",
    model: "schnell",
    prompt: "test image",
    resolution: "1024x1024",
    steps: 4,
    quantization: 8,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
  }));
  assert.throws(() => validateGenerateImageInput({
    provider: "mflux",
    model: "flux2-klein-4b",
    prompt: "test image",
    resolution: "1024x1024",
    steps: 5,
    quantization: 8,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
  }));
  assert.throws(() => validateGenerateImageInput({
    provider: "mflux",
    model: "flux2-klein-4b",
    prompt: "test image",
    resolution: "1024x1024",
    steps: 4,
    quantization: 8,
    lowRam: false,
    vaeTiling: true,
    vaeTileSize: 1024,
  }));
  assert.throws(() => validateGenerateImageInput({
    provider: "mflux",
    model: "qwen-image-edit",
    prompt: "edit image",
    resolution: "1024x1024",
    steps: 4,
    quantization: 8,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
    guidance: 2.5,
    inputReference: referenceImage,
  }));
  assert.throws(() => validateGenerateImageInput({
    provider: "mflux",
    model: "qwen-image-edit",
    prompt: "edit image",
    resolution: "1024x1024",
    steps: 20,
    quantization: 8,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
  }));
  assert.doesNotThrow(() => validateGenerateImageInput({
    provider: "mflux",
    model: "qwen-image-edit",
    prompt: "edit image",
    resolution: "1024x1024",
    steps: 20,
    quantization: 8,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
    guidance: 2.5,
    inputReference: referenceImage,
  }));
});

test("MFLUX adapter returns and cleans a generated raster", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "motio-mflux-test-"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "motio-mflux-output-test-"));
  const binary = path.join(directory, "mflux-generate-flux2");
  const editDirectory = path.join(directory, "bin");
  const editBinary = path.join(editDirectory, "mflux-generate-flux2-edit");
  const previousFlux2Binary = process.env.MFLUX_FLUX2_BINARY;
  const previousQwenEditBinary = process.env.MFLUX_QWEN_EDIT_BINARY;
  const previousTemporaryDirectory = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  const fakeBinary = `#!/usr/bin/env node
const { readFileSync, statSync, truncateSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename } = require("node:path");
const output = process.argv[process.argv.indexOf("--output") + 1];
const prompt = readFileSync(process.argv[process.argv.indexOf("--prompt-file") + 1], "utf8");
for (const argument of ["--model", "--prompt-file", "--steps", "--width", "--height"]) {
  if (!process.argv.includes(argument)) process.exit(2);
}
const model = process.argv[process.argv.indexOf("--model") + 1];
if (model !== "flux2-klein-4b" && model !== "qwen-image-edit") process.exit(2);
const steps = Number(process.argv[process.argv.indexOf("--steps") + 1]);
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
if (prompt === "edit image") {
  for (const argument of ["20", "--quantize", "8", "--guidance", "2.5", "--image-paths"]) {
    if (!process.argv.includes(argument)) process.exit(2);
  }
  if (process.argv.includes("--image-path") || process.argv.includes("--image-strength")) process.exit(2);
}
if ((prompt === "wait" || prompt === "invalid output") && basename(process.argv[1]) !== "mflux-generate-flux2") process.exit(2);
const width = process.argv[process.argv.indexOf("--width") + 1];
const height = process.argv[process.argv.indexOf("--height") + 1];
writeFileSync(output, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const resizeStatus = spawnSync("/usr/bin/sips", ["-z", height, width, output], { stdio: "ignore" }).status || 0;
if (prompt === "invalid output") truncateSync(output, Math.floor(statSync(output).size / 2));
process.exit(resizeStatus);
}
`;
  await mkdir(editDirectory);
  await Promise.all([writeFile(binary, fakeBinary), writeFile(editBinary, fakeBinary)]);
  await Promise.all([chmod(binary, 0o700), chmod(editBinary, 0o700)]);
  process.env.MFLUX_FLUX2_BINARY = binary;
  process.env.MFLUX_QWEN_EDIT_BINARY = binary;
  process.env.TMPDIR = temporaryRoot;
  process.env.PATH = `${editDirectory}${path.delimiter}${previousPath || ""}`;

  try {
    const result = await generateLocalMfluxImage({
      provider: "mflux",
      model: "flux2-klein-4b",
      prompt: "test image",
      resolution: "1280x720",
      steps: 3,
      quantization: null,
      seed: 42,
      lowRam: true,
      vaeTiling: false,
      vaeTileSize: 256,
      inputReference: referenceImage,
    });
    assert.equal(result.mediaType, "image/png");
    assert.ok(result.b64Json.startsWith("iVBOR"));
    const progress: LocalMfluxProgress[] = [];
    const editResult = await generateLocalMfluxImage({
      provider: "mflux",
      model: "qwen-image-edit",
      prompt: "edit image",
      resolution: "1024x1024",
      steps: 20,
      quantization: 8,
      lowRam: false,
      vaeTiling: false,
      vaeTileSize: 512,
      guidance: 2.5,
      inputReference: referenceImage,
    }, undefined, (update) => progress.push(update));
    assert.equal(editResult.mediaType, "image/png");
    assert.ok(progress.some((update) => update.phase === "generating" && update.step === 10 && update.etaSeconds === 20 && update.secondsPerStep === 2));
    assert.equal(progress.at(-1)?.phase, "decoding");
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = generateLocalMfluxImage({
      provider: "mflux",
      model: "flux2-klein-4b",
      prompt: "wait",
      resolution: "1024x1024",
      steps: 4,
      quantization: 8,
      lowRam: false,
      vaeTiling: false,
      vaeTileSize: 512,
    }, controller.signal, (update) => {
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
      generateLocalMfluxImage({
        provider: "mflux",
        model: "flux2-klein-4b",
        prompt: "invalid output",
        resolution: "1024x1024",
        steps: 4,
        quantization: 8,
        lowRam: false,
        vaeTiling: false,
        vaeTileSize: 512,
      }),
      (error) => error instanceof LocalMfluxError && error.type === "local_mflux_output_error",
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    if (previousFlux2Binary === undefined) delete process.env.MFLUX_FLUX2_BINARY;
    else process.env.MFLUX_FLUX2_BINARY = previousFlux2Binary;
    if (previousQwenEditBinary === undefined) delete process.env.MFLUX_QWEN_EDIT_BINARY;
    else process.env.MFLUX_QWEN_EDIT_BINARY = previousQwenEditBinary;
    if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporaryDirectory;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
