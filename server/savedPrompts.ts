import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAX_SAVED_PROMPTS,
  savedPromptSchema,
  savedPromptsFileSchema,
  type SavedPromptsFile,
} from "../shared/savedPrompts.js";
import { getLuvoxDataDirectory } from "./dataDirectory.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const emptyPrompts: SavedPromptsFile = { version: 1, prompts: [] };
let savedPrompts = emptyPrompts;
let writes: Promise<void> = Promise.resolve();

export function getSavedPromptsFilePath(): string {
  return path.join(getLuvoxDataDirectory(), "saved-prompts.json");
}

export async function initializeSavedPrompts(): Promise<void> {
  const filePath = getSavedPromptsFilePath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      savedPrompts = emptyPrompts;
      return;
    }
    throw error;
  }
  if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
    throw new Error(`Saved prompts file exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  try {
    savedPrompts = savedPromptsFileSchema.parse(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Saved prompts file is not valid JSON: ${filePath}`);
    }
    throw error;
  }
}

export function getSavedPrompts(): SavedPromptsFile {
  return { version: 1, prompts: [...savedPrompts.prompts] };
}

async function persist(next: SavedPromptsFile): Promise<void> {
  const filePath = getSavedPromptsFilePath();
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
    throw new Error(`Saved prompts file exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
    savedPrompts = next;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function serializeWrite(operation: () => Promise<void>): Promise<void> {
  const result = writes.then(operation, operation);
  writes = result.catch(() => undefined);
  return result;
}

export function saveSavedPrompt(value: unknown): Promise<SavedPromptsFile> {
  const prompt = savedPromptSchema.parse(value);
  return serializeWrite(() => persist({
    version: 1,
    prompts: [prompt, ...savedPrompts.prompts.filter((saved) => saved.id !== prompt.id)].slice(0, MAX_SAVED_PROMPTS),
  })).then(getSavedPrompts);
}

export function removeSavedPrompt(value: unknown): Promise<SavedPromptsFile> {
  const input = z.object({ id: z.string().uuid() }).strict().parse(value);
  return serializeWrite(() => persist({
    version: 1,
    prompts: savedPrompts.prompts.filter((prompt) => prompt.id !== input.id),
  })).then(getSavedPrompts);
}
