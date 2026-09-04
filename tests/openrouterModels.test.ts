import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverOpenRouterImageEndpoints, discoverOpenRouterModels, generateImage } from "../server/openrouter.js";
import {
  getOpenRouterModelRegistry,
  getOpenRouterModelsFilePath,
  initializeOpenRouterModels,
  OpenRouterModelConfigError,
  removeOpenRouterModel,
  saveOpenRouterModel,
} from "../server/openrouterModels.js";
import { validateGenerateImageInput, validateGenerateVideoInput } from "../server/validation.js";

const imageModel = {
  id: "example/raster-image",
  name: "Example Raster Image",
  provider: { id: "example-provider/global", name: "Example Provider" },
  outputFormat: "png" as const,
  aspectRatios: ["1:1", "16:9"],
  defaultAspectRatio: "1:1",
  resolutions: ["1K", "2K"],
  defaultResolution: "1K",
  inputReference: { supported: true, required: false },
};

const videoModel = {
  id: "example/text-video",
  name: "Example Text Video",
  durations: [4, 6],
  defaultDuration: 6,
  aspectRatios: ["16:9", "9:16"],
  defaultAspectRatio: "16:9",
  resolutions: ["720p"],
  defaultResolution: "720p",
  frameImages: { supported: ["first_frame" as const], input: "public_url" as const },
  generateAudio: { supported: true, default: false },
};

test("custom OpenRouter models persist without replacing built-ins", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "luvox-models-"));
  const previousDirectory = process.env.LUVOX_DATA_DIR;
  process.env.LUVOX_DATA_DIR = directory;
  try {
    await initializeOpenRouterModels();
    assert.deepEqual(getOpenRouterModelRegistry().customImageIds, []);

    await saveOpenRouterModel({ kind: "image", model: imageModel });
    await saveOpenRouterModel({ kind: "video", model: videoModel });
    const persisted = JSON.parse(await readFile(getOpenRouterModelsFilePath(), "utf8"));
    assert.equal(persisted.version, 1);
    assert.deepEqual(persisted.images, [imageModel]);
    assert.deepEqual(persisted.videos, [videoModel]);

    assert.equal(validateGenerateImageInput({
      provider: "openrouter",
      prompt: "test",
      model: imageModel.id,
      aspectRatio: "16:9",
      resolution: "2K",
    }).model, imageModel.id);
    assert.equal(validateGenerateVideoInput({
      provider: "openrouter",
      prompt: "test",
      model: videoModel.id,
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
    }).model, videoModel.id);

    await assert.rejects(
      saveOpenRouterModel({ kind: "image", model: { ...imageModel, id: "meta/muse-image" } }),
      (error) => error instanceof OpenRouterModelConfigError && error.status === 409,
    );
    assert.throws(() => removeOpenRouterModel("not an object"));

    await removeOpenRouterModel({ kind: "image", id: imageModel.id });
    assert.deepEqual(getOpenRouterModelRegistry().customImageIds, []);
    assert.ok(getOpenRouterModelRegistry().images.some((model) => model.id === "meta/muse-image"));

    const hundredModels = Array.from({ length: 100 }, (_, index) => ({
      ...imageModel,
      id: `example/image-${index}`,
    }));
    await writeFile(getOpenRouterModelsFilePath(), JSON.stringify({ version: 1, images: hundredModels, videos: [] }), "utf8");
    await initializeOpenRouterModels();
    await assert.rejects(saveOpenRouterModel({
      kind: "image",
      model: { ...imageModel, id: "example/image-100" },
    }));
    assert.equal(JSON.parse(await readFile(getOpenRouterModelsFilePath(), "utf8")).images.length, 100);

    await writeFile(getOpenRouterModelsFilePath(), "{bad json", "utf8");
    await assert.rejects(initializeOpenRouterModels(), /not valid JSON/);
  } finally {
    if (previousDirectory === undefined) delete process.env.LUVOX_DATA_DIR;
    else process.env.LUVOX_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenRouter discovery maps only Luvox-compatible media models without credentials", async () => {
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (request, init) => {
    requested.push(String(request));
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (String(request).endsWith("/images/models")) {
      return Response.json({ data: [
        {
          id: "example/raster-image",
          name: "Raster Image",
          description: "Raster output",
          supported_parameters: {
            aspect_ratio: { type: "enum", values: ["16:9", "1:1"] },
            resolution: { type: "enum", values: ["2K", "1K"] },
            input_references: { type: "range", min: 0, max: 1 },
            quality: { type: "enum", values: ["low", "high"] },
          },
        },
        {
          id: "example/vector-image",
          name: "Vector Image",
          supported_parameters: { output_format: { type: "enum", values: ["svg"] } },
        },
        {
          id: "example/multi-reference",
          name: "Multi Reference",
          supported_parameters: { input_references: { type: "range", min: 2, max: 4 } },
        },
      ] });
    }
    if (String(request).endsWith("/images/models/example/raster-image/endpoints")) {
      return Response.json({
        id: "example/raster-image",
        endpoints: [{
          provider_name: "Example Provider",
          provider_slug: "example-provider",
          provider_tag: "example-provider/global",
          supported_parameters: {
            aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
            input_references: { type: "range", min: 0, max: 1 },
            output_format: { type: "enum", values: ["png", "svg"] },
          },
          allowed_passthrough_parameters: ["style"],
        }, {
          provider_name: "Unpinnable Provider",
          provider_slug: "unpinnable",
          provider_tag: null,
          supported_parameters: {},
        }],
      });
    }
    return Response.json({ data: [
      {
        id: "example/text-video",
        name: "Text Video",
        description: "Text to video",
        supported_durations: [4, 6],
        supported_aspect_ratios: ["9:16", "16:9"],
        supported_resolutions: ["1080p", "720p"],
        supported_frame_images: ["first_frame"],
        generate_audio: true,
        seed: true,
      },
      { id: "example/upscaler", name: "Upscaler", supported_durations: null, supported_aspect_ratios: null },
    ] });
  };
  try {
    const images = await discoverOpenRouterModels("image");
    assert.equal(images.models.length, 1);
    assert.equal(images.omitted, 2);
    assert.equal(images.models[0].model.defaultAspectRatio, "1:1");
    assert.deepEqual(images.models[0].providerDefaults, ["quality"]);

    const endpoints = await discoverOpenRouterImageEndpoints("example/raster-image");
    assert.equal(endpoints.models.length, 1);
    assert.deepEqual(endpoints.models[0].model.provider, { id: "example-provider/global", name: "Example Provider" });
    assert.equal(endpoints.omitted, 1);
    assert.equal(endpoints.models[0].model.outputFormat, "png");
    assert.deepEqual(endpoints.models[0].providerDefaults, ["provider.style"]);

    const videos = await discoverOpenRouterModels("video");
    assert.equal(videos.models.length, 1);
    assert.equal(videos.omitted, 1);
    assert.equal(videos.models[0].model.defaultDuration, 6);
    assert.equal(videos.models[0].model.defaultResolution, "720p");
    assert.deepEqual(videos.models[0].providerDefaults, ["seed"]);
    assert.deepEqual(requested, [
      "https://openrouter.ai/api/v1/images/models",
      "https://openrouter.ai/api/v1/images/models/example/raster-image/endpoints",
      "https://openrouter.ai/api/v1/videos/models",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("image generation forwards configured normalized controls", async () => {
  const previousFetch = globalThis.fetch;
  const previousDirectory = process.env.LUVOX_DATA_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), "luvox-image-request-"));
  process.env.LUVOX_DATA_DIR = directory;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_request, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] });
  };
  try {
    await initializeOpenRouterModels();
    await saveOpenRouterModel({ kind: "image", model: imageModel });
    await generateImage({
      provider: "openrouter",
      prompt: "test",
      model: imageModel.id,
      aspectRatio: "16:9",
      resolution: "2K",
    }, "test-key");
    assert.equal(requestBody.aspect_ratio, "16:9");
    assert.equal(requestBody.resolution, "2K");
    assert.equal(requestBody.output_format, "png");
    assert.deepEqual(requestBody.provider, { only: ["example-provider/global"], allow_fallbacks: false });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDirectory === undefined) delete process.env.LUVOX_DATA_DIR;
    else process.env.LUVOX_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
