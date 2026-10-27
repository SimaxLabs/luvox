import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getSavedPrompts,
  getSavedPromptsFilePath,
  initializeSavedPrompts,
  removeSavedPrompt,
  saveSavedPrompt,
} from "../server/savedPrompts.js";
import { MAX_SAVED_PROMPTS, type SavedPrompt } from "../shared/savedPrompts.js";
import { clearLegacySavedPrompts, readLegacySavedPrompts } from "../src/savedPrompts.js";

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
      model: "flux2-klein-4b",
      resolution: "1024x1024",
      steps: 4,
      quantization: 8,
      seed: "42",
      lowRam: false,
      vaeTiling: true,
      vaeTileSize: 512,
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

test("legacy browser prompts are validated for migration", () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    removeItem: () => { value = null; },
  };

  assert.deepEqual(readLegacySavedPrompts(storage), []);
  value = JSON.stringify({ version: 1, prompts });
  assert.deepEqual(readLegacySavedPrompts(storage), prompts);

  const persisted = JSON.parse(value!);
  persisted.prompts.push({ ...prompts[0], id: "not-a-uuid", secret: "must not survive validation" });
  value = JSON.stringify(persisted);
  assert.throws(() => readLegacySavedPrompts(storage), /original browser copy has been kept/);

  value = "{bad json";
  assert.throws(() => readLegacySavedPrompts(storage), /original browser copy has been kept/);
  value = JSON.stringify({ version: 2, prompts });
  assert.throws(() => readLegacySavedPrompts(storage), /original browser copy has been kept/);

  clearLegacySavedPrompts(storage);
  assert.equal(value, null);
  assert.throws(() => readLegacySavedPrompts({ getItem: () => { throw new Error("blocked"); } }), /blocked/);
  assert.throws(() => clearLegacySavedPrompts({ removeItem: () => { throw new Error("blocked"); } }), /blocked/);
});

test("saved prompts persist on disk and update by id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "luvox-prompts-"));
  const previousDirectory = process.env.LUVOX_DATA_DIR;
  process.env.LUVOX_DATA_DIR = directory;
  try {
    await initializeSavedPrompts();
    assert.deepEqual(getSavedPrompts().prompts, []);

    await saveSavedPrompt(prompts[0]);
    await saveSavedPrompt(prompts[1]);
    await saveSavedPrompt({ ...prompts[0], name: "Updated" });
    assert.deepEqual(getSavedPrompts().prompts.map(({ id, name }) => ({ id, name })), [
      { id: prompts[0].id, name: "Updated" },
      { id: prompts[1].id, name: prompts[1].name },
    ]);

    const persisted = JSON.parse(await readFile(getSavedPromptsFilePath(), "utf8"));
    assert.deepEqual(persisted, getSavedPrompts());
    await removeSavedPrompt({ id: prompts[0].id });
    await initializeSavedPrompts();
    assert.deepEqual(getSavedPrompts().prompts, [prompts[1]]);

    await saveSavedPrompt(prompts[2]);
    const legacy = {
      ...prompts[2],
      settings: { ...prompts[2].settings, model: "qwen-image-edit", steps: 20, guidance: 2.5 },
    };
    await initializeSavedPrompts();
    assert.deepEqual(getSavedPrompts().prompts[0], prompts[2]);
    await saveSavedPrompt(legacy);
    await initializeSavedPrompts();
    assert.deepEqual(getSavedPrompts().prompts[0], legacy);

    const legacyTurbo = { ...prompts[2], settings: { ...prompts[2].settings, model: "z-image-turbo", steps: 9, referenceStrength: 0.15 } };
    await saveSavedPrompt(legacyTurbo);
    await initializeSavedPrompts();
    assert.deepEqual(getSavedPrompts().prompts[0], legacyTurbo);
    for (const referenceStrength of [-0.1, 1, Infinity]) {
      assert.throws(() => saveSavedPrompt({ ...legacyTurbo, settings: { ...legacyTurbo.settings, referenceStrength } }));
    }
    const outpainting = { ...prompts[2], settings: { ...prompts[2].settings, model: "flux2-klein-9b", generateMissing: true } };
    await saveSavedPrompt(outpainting);
    await initializeSavedPrompts();
    assert.deepEqual(getSavedPrompts().prompts[0], outpainting);
    assert.throws(() => saveSavedPrompt({ ...outpainting, settings: { ...outpainting.settings, generateMissing: "true" } }));

    assert.throws(() => saveSavedPrompt({ ...prompts[0], secret: "not allowed" }));
    assert.throws(() => saveSavedPrompt({
      ...prompts[2],
      settings: { ...prompts[2].settings, loras: [{ source: "/private/adapter.safetensors", scale: 1 }] },
    }));
    await writeFile(getSavedPromptsFilePath(), "{bad json", "utf8");
    await assert.rejects(initializeSavedPrompts(), /not valid JSON/);
  } finally {
    if (previousDirectory === undefined) delete process.env.LUVOX_DATA_DIR;
    else process.env.LUVOX_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full prompt library rejects additions without losing data and still permits updates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "luvox-prompts-limit-"));
  const previousDirectory = process.env.LUVOX_DATA_DIR;
  process.env.LUVOX_DATA_DIR = directory;
  try {
    const existing = Array.from({ length: MAX_SAVED_PROMPTS - 1 }, (_, index) => ({
      ...prompts[0], id: randomUUID(), name: `Saved ${index}`,
    }));
    await writeFile(getSavedPromptsFilePath(), JSON.stringify({ version: 1, prompts: existing }));
    await initializeSavedPrompts();
    const additions = await Promise.allSettled([
      saveSavedPrompt({ ...prompts[0], id: randomUUID(), name: "Last free slot" }),
      saveSavedPrompt({ ...prompts[0], id: randomUUID(), name: "One too many" }),
    ]);
    assert.equal(additions[0].status, "fulfilled");
    assert.equal(additions[1].status, "rejected");
    const before = await readFile(getSavedPromptsFilePath(), "utf8");
    await assert.rejects(saveSavedPrompt({ ...prompts[0], id: randomUUID() }), /library is full/);
    assert.equal(await readFile(getSavedPromptsFilePath(), "utf8"), before);
    await initializeSavedPrompts();
    assert.equal(getSavedPrompts().prompts.length, MAX_SAVED_PROMPTS);
    for (const prompt of existing) assert.ok(getSavedPrompts().prompts.some((saved) => saved.id === prompt.id));

    await saveSavedPrompt({ ...existing[0], name: "Updated at capacity" });
    await initializeSavedPrompts();
    assert.equal(getSavedPrompts().prompts[0].name, "Updated at capacity");
    assert.equal(getSavedPrompts().prompts.length, MAX_SAVED_PROMPTS);
    await removeSavedPrompt({ id: existing[0].id });
    await saveSavedPrompt({ ...prompts[0], id: randomUUID() });
    assert.equal(getSavedPrompts().prompts.length, MAX_SAVED_PROMPTS);
  } finally {
    if (previousDirectory === undefined) delete process.env.LUVOX_DATA_DIR;
    else process.env.LUVOX_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
