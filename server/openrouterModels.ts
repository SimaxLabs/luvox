import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OPENROUTER_IMAGE_MODELS, type OpenRouterImageModelConfig } from "../shared/imageModels.js";
import type {
  OpenRouterModelDefinition,
  OpenRouterModelRegistry,
  OpenRouterModelsFile,
} from "../shared/openrouterModels.js";
import { VIDEO_MODELS, type VideoModelConfig } from "../shared/videoModels.js";

const MAX_CONFIG_BYTES = 256 * 1024;
const modelIdSchema = z.string().trim().min(3).max(200).regex(
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i,
  "Model IDs must use the OpenRouter author/model format.",
);
const nameSchema = z.string().trim().min(1).max(200);
const optionSchema = z.string().trim().min(1).max(40);
const optionListSchema = z.array(optionSchema).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Model options must be unique.",
);
const nonEmptyOptionListSchema = z.array(optionSchema).min(1).max(64).refine(
  (values) => new Set(values).size === values.length,
  "Model options must be unique.",
);

function validateDefault(
  values: string[],
  defaultValue: string | null,
  field: string,
  context: z.RefinementCtx,
): void {
  if ((values.length === 0) !== (defaultValue === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: values.length === 0 ? "The default must be null when no options exist." : "Choose a default from the available options.",
    });
  } else if (defaultValue !== null && !values.includes(defaultValue)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: "Choose a default from the available options.",
    });
  }
}

const imageModelSchema = z
  .object({
    id: modelIdSchema,
    name: nameSchema,
    price: z.string().trim().min(1).max(200).optional(),
    provider: z.object({
      id: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._\/-]*$/i, "Invalid OpenRouter provider ID."),
      name: nameSchema,
    }).strict(),
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
    aspectRatios: optionListSchema,
    defaultAspectRatio: optionSchema.nullable(),
    resolutions: optionListSchema,
    defaultResolution: optionSchema.nullable(),
    inputReference: z.object({ supported: z.boolean(), required: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((model, context) => {
    validateDefault(model.aspectRatios, model.defaultAspectRatio, "defaultAspectRatio", context);
    validateDefault(model.resolutions, model.defaultResolution, "defaultResolution", context);
    if (model.inputReference.required && !model.inputReference.supported) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputReference", "required"],
        message: "A required reference must also be supported.",
      });
    }
  });

const videoModelSchema = z
  .object({
    id: modelIdSchema,
    name: nameSchema,
    price: z.string().trim().min(1).max(200).optional(),
    durations: z.array(z.number().int().min(1).max(300)).min(1).max(300).refine(
      (values) => new Set(values).size === values.length,
      "Durations must be unique.",
    ),
    defaultDuration: z.number().int().min(1).max(300),
    aspectRatios: nonEmptyOptionListSchema,
    defaultAspectRatio: optionSchema,
    resolutions: optionListSchema,
    defaultResolution: optionSchema.nullable(),
    frameImages: z.object({
      supported: z.array(z.enum(["first_frame", "last_frame"])).max(2).refine(
        (values) => new Set(values).size === values.length,
        "Frame image types must be unique.",
      ),
      input: z.enum(["public_url", "none"]),
    }).strict(),
    generateAudio: z.object({ supported: z.boolean(), default: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((model, context) => {
    if (!model.durations.includes(model.defaultDuration)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultDuration"], message: "Choose a default from the available durations." });
    }
    if (!model.aspectRatios.includes(model.defaultAspectRatio)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultAspectRatio"], message: "Choose a default from the available aspect ratios." });
    }
    validateDefault(model.resolutions, model.defaultResolution, "defaultResolution", context);
    if ((model.frameImages.supported.length > 0) !== (model.frameImages.input === "public_url")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["frameImages", "input"], message: "Public URL input is required exactly when frame images are supported." });
    }
    if (!model.generateAudio.supported && model.generateAudio.default) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["generateAudio", "default"], message: "Audio cannot default on when it is unsupported." });
    }
  });

const modelsFileSchema = z.object({
  version: z.literal(1),
  images: z.array(imageModelSchema).max(100),
  videos: z.array(videoModelSchema).max(100),
}).strict();

const modelDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), model: imageModelSchema }).strict(),
  z.object({ kind: z.literal("video"), model: videoModelSchema }).strict(),
]);

const emptyModels: OpenRouterModelsFile = { version: 1, images: [], videos: [] };
let customModels: OpenRouterModelsFile = emptyModels;
let writes: Promise<void> = Promise.resolve();
let registryRevision = 0;

export class OpenRouterModelConfigError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly type = "model_config_error",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "OpenRouterModelConfigError";
  }
}

function dataDirectory(): string {
  const configured = process.env.LUVOX_DATA_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("LUVOX_DATA_DIR must be an absolute path.");
  }
  return configured || path.resolve(process.cwd(), ".luvox");
}

export function getOpenRouterModelsFilePath(): string {
  return path.join(dataDirectory(), "openrouter-models.json");
}

function assertUniqueIds(models: OpenRouterModelsFile): void {
  for (const [kind, entries, builtIns] of [
    ["image", models.images, OPENROUTER_IMAGE_MODELS],
    ["video", models.videos, VIDEO_MODELS],
  ] as const) {
    const ids = new Set<string>(builtIns.map((model) => model.id));
    for (const model of entries) {
      if (ids.has(model.id)) {
        throw new OpenRouterModelConfigError(
          `${model.id} duplicates an existing ${kind} model. Built-in models cannot be replaced.`,
          409,
        );
      }
      ids.add(model.id);
    }
  }
}

function parseModelsFile(value: unknown): OpenRouterModelsFile {
  const parsed = modelsFileSchema.parse(value) as OpenRouterModelsFile;
  assertUniqueIds(parsed);
  return parsed;
}

export async function initializeOpenRouterModels(): Promise<void> {
  const filePath = getOpenRouterModelsFilePath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      customModels = emptyModels;
      registryRevision = 0;
      return;
    }
    throw error;
  }
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) {
    throw new Error(`OpenRouter model config exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`OpenRouter model config is not valid JSON: ${filePath}`);
  }
  customModels = parseModelsFile(value);
  registryRevision = 0;
}

export function getOpenRouterModelRegistry(): OpenRouterModelRegistry {
  return {
    revision: registryRevision,
    images: [...OPENROUTER_IMAGE_MODELS, ...customModels.images],
    videos: [...VIDEO_MODELS, ...customModels.videos],
    customImageIds: customModels.images.map((model) => model.id),
    customVideoIds: customModels.videos.map((model) => model.id),
  };
}

export function getOpenRouterImageModel(id: string): OpenRouterImageModelConfig | undefined {
  return getOpenRouterModelRegistry().images.find((model) => model.id === id);
}

export function getOpenRouterVideoModel(id: string): VideoModelConfig | undefined {
  return getOpenRouterModelRegistry().videos.find((model) => model.id === id);
}

async function persist(next: OpenRouterModelsFile): Promise<void> {
  const filePath = getOpenRouterModelsFilePath();
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) {
    throw new OpenRouterModelConfigError(`OpenRouter model config exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
    customModels = next;
    registryRevision += 1;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function serializeWrite(operation: () => Promise<void>): Promise<void> {
  const result = writes.then(operation, operation);
  writes = result.catch(() => undefined);
  return result;
}

export function saveOpenRouterModel(value: unknown): Promise<OpenRouterModelRegistry> {
  const definition = modelDefinitionSchema.parse(value) as OpenRouterModelDefinition;
  return serializeWrite(async () => {
    const next: OpenRouterModelsFile = {
      version: 1,
      images: definition.kind === "image"
        ? [...customModels.images.filter((model) => model.id !== definition.model.id), definition.model]
        : [...customModels.images],
      videos: definition.kind === "video"
        ? [...customModels.videos.filter((model) => model.id !== definition.model.id), definition.model]
        : [...customModels.videos],
    };
    await persist(parseModelsFile(next));
  }).then(getOpenRouterModelRegistry);
}

export function removeOpenRouterModel(value: unknown): Promise<OpenRouterModelRegistry> {
  const input = z.object({ kind: z.enum(["image", "video"]), id: modelIdSchema }).strict().parse(value);
  return serializeWrite(async () => {
    const builtIns = input.kind === "image" ? OPENROUTER_IMAGE_MODELS : VIDEO_MODELS;
    if (builtIns.some((model) => model.id === input.id)) {
      throw new OpenRouterModelConfigError("Built-in models cannot be removed.");
    }
    await persist(parseModelsFile({
      version: 1,
      images: input.kind === "image" ? customModels.images.filter((model) => model.id !== input.id) : [...customModels.images],
      videos: input.kind === "video" ? customModels.videos.filter((model) => model.id !== input.id) : [...customModels.videos],
    }));
  }).then(getOpenRouterModelRegistry);
}
