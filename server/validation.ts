import { z } from "zod";
import { isIP } from "node:net";
import path from "node:path";
import {
  getLocalH3QualityPreset,
  getLocalH3Resolution,
  LOCAL_H3_DURATIONS,
  LOCAL_H3_FRAME_FIT_IDS,
} from "../shared/localH3.js";
import { getVideoModel } from "../shared/videoModels.js";

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return false;

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (ipVersion === 6) {
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }

  return true;
}

const publicHttpsUrl = z
  .string()
  .trim()
  .url("Enter a valid image URL.")
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Reference images must use a public HTTPS URL.",
  })
  .refine((value) => isPublicHostname(new URL(value).hostname), {
    message: "Reference images must use a public, non-local hostname.",
  });

const optionalPublicHttpsUrl = z
  .union([publicHttpsUrl, z.literal("")])
  .optional()
  .transform((value) => value || undefined);

const optionalAbsolutePath = z
  .union([
    z
      .string()
      .trim()
      .max(4_096, "The reference image path is too long.")
      .refine((value) => path.isAbsolute(value), {
        message: "Reference image paths must be absolute.",
      }),
    z.literal(""),
  ])
  .optional()
  .transform((value) => value || undefined);

const promptSchema = z.string().trim().min(1, "Prompt is required.").max(10_000);

function customIssue(path: string, message: string): z.ZodIssue {
  return { code: z.ZodIssueCode.custom, path: [path], message };
}

const baseGenerateVideoSchema = z
  .object({
    provider: z.literal("openrouter"),
    prompt: promptSchema,
    model: z.string().trim().min(1, "Model is required."),
    duration: z.number().int("Duration must be a whole number."),
    aspectRatio: z.string().trim().min(1, "Aspect ratio is required."),
    resolution: z.string().trim().optional(),
    firstFrameUrl: optionalPublicHttpsUrl,
    lastFrameUrl: optionalPublicHttpsUrl,
    generateAudio: z.boolean().optional(),
  })
  .strict();

export type GenerateVideoInput = z.infer<typeof baseGenerateVideoSchema>;

const localGenerateVideoSchema = z
  .object({
    provider: z.literal("local"),
    prompt: promptSchema,
    resolution: z.string().trim().min(1, "Resolution is required."),
    frames: z.number().int("Frame count must be a whole number."),
    quality: z.string().trim().min(1, "Quality preset is required."),
    seed: z
      .number()
      .int("Seed must be a whole number.")
      .min(0, "Seed cannot be negative.")
      .max(Number.MAX_SAFE_INTEGER, "Seed is too large."),
    firstFramePath: optionalAbsolutePath,
    lastFramePath: optionalAbsolutePath,
    frameFit: z.enum(LOCAL_H3_FRAME_FIT_IDS).default("contain"),
    previousJobId: z
      .string()
      .regex(/^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      .optional(),
    ssdStreaming: z.boolean(),
  })
  .strict();

export type LocalGenerateVideoInput = z.infer<typeof localGenerateVideoSchema>;
export type VideoGenerateInput = GenerateVideoInput | LocalGenerateVideoInput;

export function validateGenerateVideoInput(value: unknown): VideoGenerateInput {
  const provider = z
    .object({ provider: z.enum(["openrouter", "local"]) })
    .passthrough()
    .parse(value).provider;

  if (provider === "local") {
    const input = localGenerateVideoSchema.parse(value);
    const issues: z.ZodIssue[] = [];

    if (!getLocalH3Resolution(input.resolution)) {
      issues.push(customIssue("resolution", "Unsupported local resolution preset."));
    }

    if (!LOCAL_H3_DURATIONS.some((duration) => duration.frames === input.frames)) {
      issues.push(customIssue("frames", "Unsupported local clip length."));
    }

    if (!getLocalH3QualityPreset(input.quality)) {
      issues.push(customIssue("quality", "Unsupported local quality preset."));
    }

    if (issues.length > 0) throw new z.ZodError(issues);
    return input;
  }

  const input = baseGenerateVideoSchema.parse(value);
  const model = getVideoModel(input.model);

  if (!model) {
    throw new z.ZodError([customIssue("model", "Unsupported video model.")]);
  }

  const issues: z.ZodIssue[] = [];

  if (!model.durations.includes(input.duration)) {
    issues.push(customIssue(
      "duration",
      `Duration must be one of: ${model.durations.join(", ")} seconds.`,
    ));
  }

  if (!model.aspectRatios.includes(input.aspectRatio)) {
    issues.push(customIssue(
      "aspectRatio",
      `Aspect ratio must be one of: ${model.aspectRatios.join(", ")}.`,
    ));
  }

  if (model.resolutions.length > 0 && !input.resolution) {
    issues.push(customIssue("resolution", "Resolution is required for this model."));
  } else if (
    input.resolution &&
    !model.resolutions.includes(input.resolution)
  ) {
    issues.push(customIssue(
      "resolution",
      `Resolution must be one of: ${model.resolutions.join(", ")}.`,
    ));
  }

  if (
    input.firstFrameUrl &&
    !model.frameImages.supported.includes("first_frame")
  ) {
    issues.push(customIssue(
      "firstFrameUrl",
      "This model does not support a first frame image.",
    ));
  }

  if (
    input.lastFrameUrl &&
    !model.frameImages.supported.includes("last_frame")
  ) {
    issues.push(customIssue(
      "lastFrameUrl",
      "This model does not support a last frame image.",
    ));
  }

  if (input.generateAudio && !model.generateAudio.supported) {
    issues.push(customIssue("generateAudio", "This model does not support generated audio."));
  }

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return input;
}

export function validateJobId(value: unknown): string {
  const parsed = z
    .string()
    .trim()
    .min(1, "Generation ID is required.")
    .parse(value);

  return parsed;
}
