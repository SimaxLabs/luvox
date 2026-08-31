import { z } from "zod";
import { isIP } from "node:net";
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

const baseGenerateVideoSchema = z
  .object({
    prompt: z.string().trim().min(1, "Prompt is required."),
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

export function validateGenerateVideoInput(value: unknown): GenerateVideoInput {
  const input = baseGenerateVideoSchema.parse(value);
  const model = getVideoModel(input.model);

  if (!model) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "Unsupported video model.",
      },
    ]);
  }

  const issues: z.ZodIssue[] = [];

  if (!model.durations.includes(input.duration)) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["duration"],
      message: `Duration must be one of: ${model.durations.join(", ")} seconds.`,
    });
  }

  if (!model.aspectRatios.includes(input.aspectRatio)) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["aspectRatio"],
      message: `Aspect ratio must be one of: ${model.aspectRatios.join(", ")}.`,
    });
  }

  if (model.resolutions.length > 0 && !input.resolution) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["resolution"],
      message: "Resolution is required for this model.",
    });
  } else if (
    input.resolution &&
    !model.resolutions.includes(input.resolution)
  ) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["resolution"],
      message: `Resolution must be one of: ${model.resolutions.join(", ")}.`,
    });
  }

  if (
    input.firstFrameUrl &&
    !model.frameImages.supported.includes("first_frame")
  ) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["firstFrameUrl"],
      message: "This model does not support a first frame image.",
    });
  }

  if (
    input.lastFrameUrl &&
    !model.frameImages.supported.includes("last_frame")
  ) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["lastFrameUrl"],
      message: "This model does not support a last frame image.",
    });
  }

  if (input.generateAudio && !model.generateAudio.supported) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["generateAudio"],
      message: "This model does not support generated audio.",
    });
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
