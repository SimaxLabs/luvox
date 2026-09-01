import type { LocalH3FrameFitId } from "../shared/localH3";

export type GenerationStatus = "queued" | "processing" | "completed" | "failed";

export interface VideoJob {
  id: string;
  provider: "openrouter" | "local";
  status: GenerationStatus;
  error?: string;
  videoUrl?: string;
  downloadUrl?: string;
  cost?: number;
  phase?: string;
  progress?: number;
}

export interface OpenRouterGenerateVideoPayload {
  provider: "openrouter";
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  generateAudio?: boolean;
}

export interface LocalGenerateVideoPayload {
  provider: "local";
  prompt: string;
  resolution: string;
  frames: number;
  quality: string;
  seed: number;
  firstFramePath?: string;
  lastFramePath?: string;
  frameFit: LocalH3FrameFitId;
  ssdStreaming: boolean;
}

export type GenerateVideoPayload =
  | OpenRouterGenerateVideoPayload
  | LocalGenerateVideoPayload;

interface ApiErrorBody {
  error?: {
    message?: string;
    retryable?: boolean;
  };
}

export interface AppConfig {
  localH3: {
    supported: boolean;
    configured: boolean;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function sessionKeyHeaders(sessionApiKey?: string): Record<string, string> {
  const key = sessionApiKey?.trim();
  return key ? { "X-OpenRouter-Api-Key": key } : {};
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(
      "Could not reach the local API. Make sure the backend is running.",
      0,
      true,
    );
  }

  let body: ApiErrorBody | T;
  try {
    body = (await response.json()) as ApiErrorBody | T;
  } catch {
    throw new ApiError("The local API returned an unreadable response.", response.status, true);
  }

  if (!response.ok) {
    const errorBody = body as ApiErrorBody;
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiError(
      errorBody.error?.message || `The request failed with status ${response.status}.`,
      response.status,
      errorBody.error?.retryable ?? response.status >= 500,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  return body as T;
}

export function generateVideo(
  payload: GenerateVideoPayload,
  sessionApiKey?: string,
): Promise<VideoJob> {
  return request<VideoJob>("/api/video/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionKeyHeaders(sessionApiKey),
    },
    body: JSON.stringify(payload),
  });
}

export function getAppConfig(): Promise<AppConfig> {
  return request<AppConfig>("/api/config");
}

export function uploadLocalReferenceImage(file: File): Promise<{ path: string }> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const contentType = ["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ? file.type
    : extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "webp"
          ? "image/webp"
          : "application/octet-stream";
  return request<{ path: string }>("/api/local/reference-image", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: file,
  });
}

export function getVideoStatus(
  id: string,
  sessionApiKey?: string,
  signal?: AbortSignal,
): Promise<VideoJob> {
  return request<VideoJob>(`/api/video/status/${encodeURIComponent(id)}`, {
    headers: sessionKeyHeaders(sessionApiKey),
    signal,
  });
}

export async function getVideoContent(
  url: string,
  sessionApiKey: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const contentUrl = new URL(url, window.location.origin);
  if (
    contentUrl.origin !== window.location.origin ||
    !contentUrl.pathname.startsWith("/api/video/content/") ||
    contentUrl.search
  ) {
    throw new ApiError("Refused to send the temporary key outside the local video endpoint.", 400, false);
  }

  let response: Response;

  try {
    response = await fetch(contentUrl.pathname, {
      headers: sessionKeyHeaders(sessionApiKey),
      signal,
    });
  } catch {
    throw new ApiError("Could not load the generated video from the local API.", 0, true);
  }

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // The content endpoint may return a non-JSON provider response.
    }

    throw new ApiError(
      body.error?.message || `Video download failed with status ${response.status}.`,
      response.status,
      body.error?.retryable ?? response.status >= 500,
    );
  }

  return response.blob();
}
