import assert from "node:assert/strict";
import test from "node:test";
import { persistSavedPrompts, readSavedPrompts, type SavedPrompt } from "../src/savedPrompts.js";

test("saved prompts round-trip while invalid browser data is ignored", () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
  const createdAt = "2026-09-07T12:00:00.000Z";
  const prompts: SavedPrompt[] = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Prompt only",
      prompt: "A quiet beach at dawn",
      createdAt,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "OpenRouter image",
      prompt: "A paper city",
      createdAt,
      settings: { kind: "image", model: "example/image", aspectRatio: "1:1", resolution: "1K" },
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      name: "MFLUX image",
      prompt: "Turn this into a sketch",
      createdAt,
      settings: {
        kind: "mflux",
        model: "qwen-image-edit",
        resolution: "1024x1024",
        steps: 20,
        quantization: 8,
        seed: "42",
        lowRam: false,
        vaeTiling: true,
        vaeTileSize: 512,
        guidance: 2.5,
        referenceFit: "contain",
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000004",
      name: "OpenRouter video",
      prompt: "A slow tracking shot",
      createdAt,
      settings: { kind: "openrouter", model: "example/video", duration: 6, aspectRatio: "16:9", resolution: "2K", generateAudio: true },
    },
    {
      id: "00000000-0000-4000-8000-000000000005",
      name: "Local video",
      prompt: "Clouds crossing a mountain",
      createdAt,
      settings: { kind: "local", resolution: "512x512", frames: 22, quality: "balanced", acceleration: "standard", seed: 42, frameFit: "cover", ssdStreaming: false },
    },
  ];

  assert.deepEqual(readSavedPrompts(storage), []);
  persistSavedPrompts(prompts, storage);
  assert.deepEqual(readSavedPrompts(storage), prompts);

  const persisted = JSON.parse(value!);
  persisted.prompts.push({ ...prompts[0], id: "not-a-uuid", secret: "must not survive validation" });
  value = JSON.stringify(persisted);
  assert.deepEqual(readSavedPrompts(storage), prompts);

  value = "{bad json";
  assert.deepEqual(readSavedPrompts(storage), []);
  value = JSON.stringify({ version: 2, prompts });
  assert.deepEqual(readSavedPrompts(storage), []);

  assert.throws(() => readSavedPrompts({ getItem: () => { throw new Error("blocked"); } }), /blocked/);
  assert.throws(() => persistSavedPrompts(prompts, { setItem: () => { throw new Error("full"); } }), /full/);
});
