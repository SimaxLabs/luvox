import { savedPromptsFileSchema, type SavedPrompt } from "../shared/savedPrompts";

const storageKey = "luvox.saved-prompts.v1";

export function readLegacySavedPrompts(storage: Pick<Storage, "getItem"> = window.localStorage): SavedPrompt[] {
  const raw = storage.getItem(storageKey);
  if (!raw) return [];

  try {
    return savedPromptsFileSchema.parse(JSON.parse(raw)).prompts;
  } catch {
    throw new Error("Browser prompt data is invalid. The original browser copy has been kept.");
  }
}

export function clearLegacySavedPrompts(storage: Pick<Storage, "removeItem"> = window.localStorage): void {
  storage.removeItem(storageKey);
}
