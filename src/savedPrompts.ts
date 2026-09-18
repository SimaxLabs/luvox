import { z } from "zod";
import { MAX_SAVED_PROMPTS, savedPromptSchema, type SavedPrompt } from "../shared/savedPrompts";

const storageKey = "luvox.saved-prompts.v1";
const legacySavedPromptFileSchema = z.object({
  version: z.literal(1),
  prompts: z.array(z.unknown()).max(MAX_SAVED_PROMPTS),
}).strict();

export function readLegacySavedPrompts(storage: Pick<Storage, "getItem"> = window.localStorage): SavedPrompt[] {
  const raw = storage.getItem(storageKey);
  if (!raw) return [];

  try {
    const file = legacySavedPromptFileSchema.safeParse(JSON.parse(raw));
    if (!file.success) return [];
    return file.data.prompts.flatMap((value) => {
      const prompt = savedPromptSchema.safeParse(value);
      return prompt.success ? [prompt.data] : [];
    });
  } catch {
    return [];
  }
}

export function clearLegacySavedPrompts(storage: Pick<Storage, "removeItem"> = window.localStorage): void {
  storage.removeItem(storageKey);
}
