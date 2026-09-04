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

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const JSON_REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_REQUEST_TIMEOUT_MS = 300_000;
const CONTENT_REQUEST_TIMEOUT_MS = 300_000;

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

  return publicStatus(parseVideoResponse(payload));
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
): Promise<VideoStatusResponse> {
  const payload = await requestJson(
    `/videos/${encodeURIComponent(id)}`,
    { method: "GET", signal },
    overrideApiKey,
  );

  return publicStatus(parseVideoResponse(payload));
}

export async function getVideoContent(
  id: string,
  range?: string,
  overrideApiKey?: string,
  signal?: AbortSignal,
): Promise<Response> {
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

  if (response.status === 416) return response;

  if (!response.ok) {
    const payload = await readJsonOrUndefined(response);

    throw providerError(
      response.status,
      extractErrorMessage(payload),
      response.headers.get("retry-after"),
    );
  }

  return response;
}
