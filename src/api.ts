import type { LocalH3FrameFitId } from "../shared/localH3";
import type { VideoStatusResponse as VideoJob } from "../shared/videoTypes";
import type { ImageGenerationResponse } from "../shared/imageTypes";

export type { GenerationStatus, VideoStatusResponse as VideoJob } from "../shared/videoTypes";
export type { ImageGenerationResponse } from "../shared/imageTypes";

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
  previousJobId?: string;
  ssdStreaming: boolean;
}

interface ApiErrorBody {
  error?: {
    type?: string;
    message?: string;
    retryable?: boolean;
  };
}

export interface AppConfig {
  sessionId: string;
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
    public readonly type?: string,
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
      undefined,
      "local_network_error",
    );
  }

  let body: ApiErrorBody | T;
  try {
    body = (await response.json()) as ApiErrorBody | T;
  } catch {
    throw new ApiError(
      "The local API returned an unreadable response.",
      response.status,
      true,
      undefined,
      "invalid_local_response",
    );
  }

  if (!response.ok) {
    const errorBody = body as ApiErrorBody;
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiError(
      errorBody.error?.message || `The request failed with status ${response.status}.`,
      response.status,
      errorBody.error?.retryable ?? response.status >= 500,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      errorBody.error?.type,
    );
  }

  return body as T;
}

export function generateVideo(
  payload: OpenRouterGenerateVideoPayload | LocalGenerateVideoPayload,
  sessionApiKey?: string,
  signal?: AbortSignal,
): Promise<VideoJob> {
  return request<VideoJob>("/api/video/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionKeyHeaders(sessionApiKey),
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export function generateImage(
  payload: { prompt: string; model: string; inputReference?: string },
  sessionApiKey?: string,
  signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
  return request<ImageGenerationResponse>("/api/image/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionKeyHeaders(sessionApiKey),
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export function getAppConfig(signal?: AbortSignal): Promise<AppConfig> {
  return request<AppConfig>("/api/config", { signal });
}

export function uploadLocalReferenceImage(
  file: File,
  uploadToken: string,
  previousToken?: string,
): Promise<{ path: string; token: string }> {
  return request<{ path: string; token: string }>("/api/local/reference-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Reference-Upload-Token": uploadToken,
      ...(previousToken ? { "X-Previous-Reference-Token": previousToken } : {}),
    },
    body: file,
  });
}

export function deleteLocalReferenceImage(token: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>("/api/local/reference-image", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export function discardLocalWorkspace(): Promise<{ cleared: true }> {
  return request<{ cleared: true }>("/api/local/workspace", { method: "DELETE" });
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
