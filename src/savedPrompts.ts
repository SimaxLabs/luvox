import { z } from "zod";

export const MAX_SAVED_PROMPTS = 100;
const storageKey = "luvox.saved-prompts.v1";
const shortString = z.string().max(512);
const frameFit = z.enum(["contain", "cover"]);

const savedPromptSettingsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    model: shortString,
    aspectRatio: shortString,
    resolution: shortString,
  }).strict(),
  z.object({
    kind: z.literal("mflux"),
    model: shortString,
    resolution: shortString,
    steps: z.number().int().positive().max(1_000),
    quantization: z.number().int().positive().max(16).nullable(),
    seed: z.string().regex(/^\d{0,10}$/).refine((value) => !value || Number(value) <= 4_294_967_295),
    lowRam: z.boolean(),
    vaeTiling: z.boolean(),
    vaeTileSize: z.number().int().min(64).max(4_096),
    guidance: z.number().min(0).max(20),
    referenceFit: frameFit,
  }).strict(),
  z.object({
    kind: z.literal("openrouter"),
    model: shortString,
    duration: z.number().int().positive().max(3_600),
    aspectRatio: shortString,
    resolution: shortString,
    generateAudio: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("local"),
    resolution: shortString,
    frames: z.number().int().positive().max(10_000),
    quality: shortString,
    acceleration: shortString,
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    frameFit,
    ssdStreaming: z.boolean(),
  }).strict(),
]);

const savedPromptSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  prompt: z.string().max(10_000).refine((value) => Boolean(value.trim())),
  createdAt: z.string().datetime(),
  settings: savedPromptSettingsSchema.optional(),
}).strict();

const savedPromptFileSchema = z.object({
  version: z.literal(1),
  prompts: z.array(z.unknown()).max(MAX_SAVED_PROMPTS),
}).strict();

export type SavedPrompt = z.infer<typeof savedPromptSchema>;
export type SavedPromptSettings = z.infer<typeof savedPromptSettingsSchema>;

export function readSavedPrompts(storage: Pick<Storage, "getItem"> = window.localStorage): SavedPrompt[] {
  const raw = storage.getItem(storageKey);
  if (!raw) return [];

  try {
    const file = savedPromptFileSchema.safeParse(JSON.parse(raw));
    if (!file.success) return [];
    return file.data.prompts.flatMap((value) => {
      const prompt = savedPromptSchema.safeParse(value);
      return prompt.success ? [prompt.data] : [];
    });
  } catch {
    return [];
  }
}

export function persistSavedPrompts(
  prompts: SavedPrompt[],
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  const validated = z.array(savedPromptSchema).max(MAX_SAVED_PROMPTS).parse(prompts);
  storage.setItem(storageKey, JSON.stringify({ version: 1, prompts: validated }));
}
