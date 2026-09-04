import { randomUUID } from "node:crypto";
import {
  rasterMediaType,
  type OpenRouterGenerateImageInput,
  type GenerateVideoInput,
} from "./validation.js";
import type {
  GenerationStatus,
  VideoStatusResponse,
} from "../shared/videoTypes.js";
import type {
  ImageGenerationResponse,
} from "../shared/imageTypes.js";
import type { OpenRouterImageModelConfig } from "../shared/imageModels.js";
import type {
  DiscoveredOpenRouterModel,
  OpenRouterDiscoveryResponse,
} from "../shared/openrouterModels.js";
import type { VideoModelConfig } from "../shared/videoModels.js";
import { getOpenRouterImageModel } from "./openrouterModels.js";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const JSON_REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_REQUEST_TIMEOUT_MS = 300_000;
const CONTENT_REQUEST_TIMEOUT_MS = 300_000;
const VIDEO_CONTENT_TYPES = new Set(["application/octet-stream", "video/mp4"]);
const VIDEO_CAPABILITY_IDLE_MS = 24 * 60 * 60 * 1_000;
const videoCapabilities = new Map<string, { id: string; expiresAt: number }>();

const OPENROUTER_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

type OpenRouterStatus = (typeof OPENROUTER_STATUSES)[number];

interface OpenRouterVideoResponse {
  id: string;
  polling_url: string;
  status: OpenRouterStatus;
  error?: string;
  usage?: {
    cost?: number | null;
  };
}

interface OpenRouterImageResponse {
  data: Array<{
    b64_json: string;
    media_type?: string;
  }>;
  usage?: {
    cost?: number | null;
  };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string,
    public readonly retryable: boolean,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function getApiKey(overrideApiKey?: string): string {
  const apiKey = overrideApiKey?.trim() || process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    throw new OpenRouterError(
      "No OpenRouter API key is available. Configure OPENROUTER_API_KEY or enter a temporary session key.",
      503,
      "configuration_error",
      false,
    );
  }

  return apiKey;
}

function assertVideoAccess(id: string, overrideApiKey?: string, capabilityToken?: string): void {
  if (overrideApiKey?.trim()) return;
  const capability = capabilityToken ? videoCapabilities.get(capabilityToken) : undefined;
  const now = Date.now();
  if (capability && capability.expiresAt <= now) videoCapabilities.delete(capabilityToken!);
  else if (capability?.id === id) {
    capability.expiresAt = now + VIDEO_CAPABILITY_IDLE_MS;
    return;
  }
  throw new OpenRouterError("The video generation was not found.", 404, "not_found", false);
}

export function releaseVideoCapability(id: string, capabilityToken: string): { released: true } {
  const capability = videoCapabilities.get(capabilityToken);
  if (capability?.expiresAt && capability.expiresAt <= Date.now()) videoCapabilities.delete(capabilityToken);
  else if (capability && capability.id !== id) {
    throw new OpenRouterError("The video generation was not found.", 404, "not_found", false);
  }
  else if (capability) videoCapabilities.delete(capabilityToken);
  return { released: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.error;

  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return undefined;
}

async function readJsonOrUndefined(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function providerError(
  upstreamStatus: number,
  details: string | undefined,
  retryAfter: string | null,
): OpenRouterError {
  if (upstreamStatus === 400 || upstreamStatus === 413) {
    return new OpenRouterError(
      details ? `OpenRouter rejected the request: ${details}` : "OpenRouter rejected the request.",
      upstreamStatus,
      "invalid_request",
      false,
    );
  }

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return new OpenRouterError(
      "OpenRouter rejected the API key. Check the temporary key or OPENROUTER_API_KEY.",
      401,
      "authentication_error",
      false,
    );
  }

  if (upstreamStatus === 402) {
    return new OpenRouterError(
      "The OpenRouter account has insufficient credits for this generation.",
      402,
      "insufficient_credits",
      false,
    );
  }

  if (upstreamStatus === 404) {
    return new OpenRouterError(
      details || "The requested model or generation was not found.",
      404,
      "not_found",
      false,
    );
  }

  if (upstreamStatus === 429) {
    return new OpenRouterError(
      "OpenRouter rate limit reached. Try again after a short wait.",
      429,
      "rate_limit",
      true,
      retryAfter || undefined,
    );
  }

  const suffix = details ? `: ${details}` : ".";
  return new OpenRouterError(
    `OpenRouter or its provider returned an error${suffix}`,
    502,
    "provider_error",
    true,
    retryAfter || undefined,
  );
}

async function fetchOpenRouter(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  overrideApiKey?: string,
): Promise<Response> {
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return await fetch(`${OPENROUTER_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${getApiKey(overrideApiKey)}`,
        ...init.headers,
      },
      signal: init.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal,
    });
  } catch (error) {
    if (error instanceof OpenRouterError) throw error;

    if (init.signal?.aborted) {
      throw new OpenRouterError(
        "The OpenRouter request was cancelled.",
        499,
        "request_cancelled",
        false,
      );
    }

    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new OpenRouterError(
        "OpenRouter did not respond before the request timed out.",
        504,
        "timeout",
        true,
      );
    }

    throw new OpenRouterError(
      "Could not connect to OpenRouter. Check the server network connection.",
      502,
      "network_error",
      true,
    );
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  overrideApiKey?: string,
  timeoutMs = JSON_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchOpenRouter(
    path,
    init,
    timeoutMs,
    overrideApiKey,
  );
  const payload = await readJsonOrUndefined(response);

  if (!response.ok) {
    throw providerError(
      response.status,
      extractErrorMessage(payload),
      response.headers.get("retry-after"),
    );
  }

  return payload;
}

async function requestPublicJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(JSON_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(JSON_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw new OpenRouterError("Model discovery was cancelled.", 499, "request_cancelled", false);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new OpenRouterError("OpenRouter model discovery timed out.", 504, "timeout", true);
    }
    throw new OpenRouterError("Could not load models from OpenRouter.", 502, "network_error", true);
  }
  const payload = await readJsonOrUndefined(response);
  if (!response.ok) {
    throw new OpenRouterError("OpenRouter model discovery is temporarily unavailable.", 502, "provider_error", true, response.headers.get("retry-after") || undefined);
  }
  return payload;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 40))].slice(0, 64);
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => Number.isInteger(item) && item >= 1 && item <= 300))].slice(0, 300);
}

function parameterValues(parameters: Record<string, unknown>, name: string): string[] {
  const descriptor = parameters[name];
  return isRecord(descriptor) && descriptor.type === "enum" ? stringList(descriptor.values) : [];
}

function preferred<T extends string | number>(values: T[], choices: readonly T[]): T {
  return choices.find((choice) => values.includes(choice)) ?? values[0];
}

function mapDiscoveredImage(value: unknown): Extract<DiscoveredOpenRouterModel, { kind: "image" }> | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const parameters = isRecord(value.supported_parameters) ? value.supported_parameters : {};
  const outputFormats = parameterValues(parameters, "output_format");
  if (outputFormats.length > 0 && !outputFormats.some((format) => format === "png" || format === "jpeg" || format === "webp")) return undefined;
  const rasterFormats = outputFormats.filter((format): format is "png" | "jpeg" | "webp" => format === "png" || format === "jpeg" || format === "webp");
  const outputFormat = rasterFormats.find((format) => format === "png") ?? rasterFormats[0];

  const referenceDescriptor = parameters.input_references;
  const referenceMin = isRecord(referenceDescriptor) && typeof referenceDescriptor.min === "number" ? referenceDescriptor.min : 0;
  const referenceMax = isRecord(referenceDescriptor) && typeof referenceDescriptor.max === "number" ? referenceDescriptor.max : 0;
  if (referenceMin > 1) return undefined;

  const aspectRatios = parameterValues(parameters, "aspect_ratio");
  const resolutions = parameterValues(parameters, "resolution");
  const model: OpenRouterImageModelConfig = {
    id: value.id,
    name: value.name,
    ...(outputFormat ? { outputFormat } : {}),
    aspectRatios,
    defaultAspectRatio: aspectRatios.length > 0 ? preferred(aspectRatios, ["1:1", "auto"]) : null,
    resolutions,
    defaultResolution: resolutions.length > 0 ? preferred(resolutions, ["1K", "1024", "2K"]) : null,
    inputReference: {
      supported: referenceMax >= 1,
      required: referenceMin === 1,
    },
  };
  const handled = new Set(["aspect_ratio", "resolution", "input_references", "n", "output_format"]);
  return {
    kind: "image",
    description: typeof value.description === "string" ? value.description : "",
    providerDefaults: Object.keys(parameters).filter((name) => !handled.has(name)).sort(),
    model,
  };
}

function mapDiscoveredVideo(value: unknown): Extract<DiscoveredOpenRouterModel, { kind: "video" }> | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const durations = numberList(value.supported_durations);
  const aspectRatios = stringList(value.supported_aspect_ratios);
  if (durations.length === 0 || aspectRatios.length === 0) return undefined;
  const resolutions = stringList(value.supported_resolutions);
  const supportedFrames = stringList(value.supported_frame_images).filter(
    (frame): frame is "first_frame" | "last_frame" => frame === "first_frame" || frame === "last_frame",
  );
  const audioSupported = value.generate_audio === true;
  const model: VideoModelConfig = {
    id: value.id,
    name: value.name,
    durations,
    defaultDuration: preferred(durations, [6, 5, 4, 8]),
    aspectRatios,
    defaultAspectRatio: preferred(aspectRatios, ["16:9", "1:1", "9:16"]),
    resolutions,
    defaultResolution: resolutions.length > 0 ? preferred(resolutions, ["720p", "1080p", "768p", "2K", "480p"]) : null,
    frameImages: {
      supported: supportedFrames,
      input: supportedFrames.length > 0 ? "public_url" : "none",
    },
    generateAudio: {
      supported: audioSupported,
      default: audioSupported,
    },
  };
  const providerDefaults = [
    ...(value.seed === true ? ["seed"] : []),
    ...stringList(value.allowed_passthrough_parameters).map((name) => `provider.${name}`),
  ];
  return {
    kind: "video",
    description: typeof value.description === "string" ? value.description : "",
    providerDefaults,
    model,
  };
}

export async function discoverOpenRouterModels(
  kind: "image" | "video",
  signal?: AbortSignal,
): Promise<OpenRouterDiscoveryResponse> {
  const payload = await requestPublicJson(kind === "image" ? "/images/models" : "/videos/models", signal);
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new OpenRouterError("OpenRouter returned an invalid model list.", 502, "invalid_provider_response", true);
  }
  const mapped: Array<DiscoveredOpenRouterModel | undefined> = kind === "image"
    ? payload.data.map(mapDiscoveredImage)
    : payload.data.map(mapDiscoveredVideo);
  const models = mapped.filter((model): model is DiscoveredOpenRouterModel => Boolean(model));
  return { models, omitted: payload.data.length - models.length };
}

export async function discoverOpenRouterImageEndpoints(
  modelId: string,
  signal?: AbortSignal,
): Promise<OpenRouterDiscoveryResponse> {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(modelId)) {
    throw new OpenRouterError("Invalid OpenRouter model ID.", 400, "invalid_request", false);
  }
  const [author, slug] = modelId.split("/", 2);
  const payload = await requestPublicJson(
    `/images/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
    signal,
  );
  if (!isRecord(payload) || !Array.isArray(payload.endpoints)) {
    throw new OpenRouterError("OpenRouter returned an invalid endpoint list.", 502, "invalid_provider_response", true);
  }
  const modelName = typeof payload.name === "string" ? payload.name : modelId;
  const description = typeof payload.description === "string" ? payload.description : "";
  const models = payload.endpoints.flatMap((endpoint) => {
    if (!isRecord(endpoint)) return [];
    const providerId = typeof endpoint.provider_tag === "string" ? endpoint.provider_tag : undefined;
    if (!providerId) return [];
    const mapped = mapDiscoveredImage({
      id: modelId,
      name: modelName,
      description,
      supported_parameters: endpoint.supported_parameters,
    });
    if (!mapped) return [];
    const passthrough = stringList(endpoint.allowed_passthrough_parameters).map((name) => `provider.${name}`);
    return [{
      ...mapped,
      providerDefaults: [...new Set([...mapped.providerDefaults, ...passthrough])].sort(),
      model: {
        ...mapped.model,
        provider: {
          id: providerId,
          name: typeof endpoint.provider_name === "string" ? endpoint.provider_name : providerId,
        },
      },
    }];
  });
  return { models, omitted: payload.endpoints.length - models.length };
}

function parseImageResponse(value: unknown): ImageGenerationResponse {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0])) {
    throw new OpenRouterError(
      "OpenRouter returned an invalid image generation response.",
      502,
      "invalid_provider_response",
      true,
    );
  }

  const image = value.data[0];
  if (typeof image.b64_json !== "string" || !image.b64_json) {
    throw new OpenRouterError(
      "OpenRouter returned an invalid image generation response.",
      502,
      "invalid_provider_response",
      true,
    );
  }

  const mediaType = rasterMediaType(image.b64_json);
  if (!mediaType) {
    throw new OpenRouterError(
      "OpenRouter returned an unsupported image format.",
      502,
      "invalid_provider_response",
      true,
    );
  }

  const response = value as unknown as OpenRouterImageResponse;
  const result: ImageGenerationResponse = {
    b64Json: image.b64_json,
    mediaType,
  };
  if (typeof response.usage?.cost === "number") result.cost = response.usage.cost;
  return result;
}

function parseVideoResponse(value: unknown): OpenRouterVideoResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.polling_url !== "string" ||
    typeof value.status !== "string" ||
    !OPENROUTER_STATUSES.includes(value.status as OpenRouterStatus)
  ) {
    throw new OpenRouterError(
      "OpenRouter returned an invalid video generation response.",
      502,
      "invalid_provider_response",
      true,
    );
  }

  return value as unknown as OpenRouterVideoResponse;
}

function publicStatus(response: OpenRouterVideoResponse): VideoStatusResponse {
  const status: GenerationStatus =
    response.status === "pending"
      ? "queued"
      : response.status === "in_progress"
        ? "processing"
        : response.status === "completed"
          ? "completed"
          : "failed";

  const result: VideoStatusResponse = {
    id: response.id,
    provider: "openrouter",
    status,
  };

  if (status === "failed") {
    const fallback =
      response.status === "cancelled"
        ? "The video generation was cancelled."
        : response.status === "expired"
          ? "The video generation expired before completion."
          : "The video provider could not complete this generation.";
    result.error = response.error || fallback;
  }

  if (status === "completed") {
    const encodedId = encodeURIComponent(response.id);
    result.videoUrl = `/api/video/content/${encodedId}`;
    result.downloadUrl = `/api/video/content/${encodedId}?download=1`;
  }

  if (typeof response.usage?.cost === "number") {
    result.cost = response.usage.cost;
  }

  return result;
}

export async function generateVideo(
  input: GenerateVideoInput,
  overrideApiKey?: string,
  signal?: AbortSignal,
): Promise<VideoStatusResponse> {
  const frameImages: Array<Record<string, unknown>> = [];

  if (input.firstFrameUrl) {
    frameImages.push({
      type: "image_url",
      image_url: { url: input.firstFrameUrl },
      frame_type: "first_frame",
    });
  }

  if (input.lastFrameUrl) {
    frameImages.push({
      type: "image_url",
      image_url: { url: input.lastFrameUrl },
      frame_type: "last_frame",
    });
  }

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
  };

  if (input.resolution) body.resolution = input.resolution;
  if (frameImages.length > 0) body.frame_images = frameImages;
  if (typeof input.generateAudio === "boolean") {
    body.generate_audio = input.generateAudio;
  }

  const payload = await requestJson(
    "/videos",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    overrideApiKey,
  );

  const result = publicStatus(parseVideoResponse(payload));
  if (!overrideApiKey?.trim() && result.status !== "failed") {
    result.capabilityToken = randomUUID();
    const now = Date.now();
    for (const [token, capability] of videoCapabilities) {
      if (capability.expiresAt <= now) videoCapabilities.delete(token);
    }
    videoCapabilities.set(result.capabilityToken, { id: result.id, expiresAt: now + VIDEO_CAPABILITY_IDLE_MS });
  }
  return result;
}

export async function generateImage(
  input: OpenRouterGenerateImageInput,
  overrideApiKey?: string,
  signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
  };
  const configuredModel = getOpenRouterImageModel(input.model);
  if (configuredModel?.provider) {
    body.provider = { only: [configuredModel.provider.id], allow_fallbacks: false };
  }
  if (configuredModel?.outputFormat) body.output_format = configuredModel.outputFormat;
  if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
  if (input.resolution) body.resolution = input.resolution;
  if (input.inputReference) {
    body.input_references = [{
      type: "image_url",
      image_url: { url: input.inputReference },
    }];
  }

  const payload = await requestJson(
    "/images",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    overrideApiKey,
    IMAGE_REQUEST_TIMEOUT_MS,
  );

  return parseImageResponse(payload);
}

export async function getVideoStatus(
  id: string,
  overrideApiKey?: string,
  signal?: AbortSignal,
  capabilityToken?: string,
): Promise<VideoStatusResponse> {
  assertVideoAccess(id, overrideApiKey, capabilityToken);
  const payload = await requestJson(
    `/videos/${encodeURIComponent(id)}`,
    { method: "GET", signal },
    overrideApiKey,
  );

  const response = parseVideoResponse(payload);
  if (response.id !== id) {
    throw new OpenRouterError(
      "OpenRouter returned a mismatched video generation response.",
      502,
      "invalid_provider_response",
      true,
    );
  }
  return publicStatus(response);
}

export async function getVideoContent(
  id: string,
  range?: string,
  overrideApiKey?: string,
  signal?: AbortSignal,
  capabilityToken?: string,
): Promise<Response> {
  assertVideoAccess(id, overrideApiKey, capabilityToken);
  const response = await fetchOpenRouter(
    `/videos/${encodeURIComponent(id)}/content?index=0`,
    {
      method: "GET",
      headers: range ? { Range: range } : undefined,
      signal,
    },
    CONTENT_REQUEST_TIMEOUT_MS,
    overrideApiKey,
  );

  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (response.status === 416) {
    const contentRange = response.headers.get("content-range");
    if ((!contentType || VIDEO_CONTENT_TYPES.has(contentType)) && /^bytes \*\/\d+$/.test(contentRange || "")) {
      return response;
    }
    void response.body?.cancel();
    throw new OpenRouterError(
      "OpenRouter returned an unsupported video format.",
      502,
      "invalid_provider_response",
      true,
    );
  }
  if (!response.ok) {
    const payload = await readJsonOrUndefined(response);

    throw providerError(
      response.status,
      extractErrorMessage(payload),
      response.headers.get("retry-after"),
    );
  }

  if (!contentType || !VIDEO_CONTENT_TYPES.has(contentType)) {
    void response.body?.cancel();
    throw new OpenRouterError(
      "OpenRouter returned an unsupported video format.",
      502,
      "invalid_provider_response",
      true,
    );
  }

  return response;
}
