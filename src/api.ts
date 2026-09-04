import type { LocalH3FrameFitId } from "../shared/localH3";
import type { VideoStatusResponse as VideoJob } from "../shared/videoTypes";
import type { ImageGenerationResponse, LocalMfluxProgress } from "../shared/imageTypes";

export type { GenerationStatus, VideoStatusResponse as VideoJob } from "../shared/videoTypes";
export type { ImageGenerationResponse, LocalMfluxProgress } from "../shared/imageTypes";

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
  acceleration: string;
  seed: number;
  firstFramePath?: string;
  lastFramePath?: string;
  frameFit: LocalH3FrameFitId;
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
  localMflux: {
    supported: boolean;
    configured: boolean;
    models: string[];
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

function localWorkspaceHeaders(workspaceToken?: string): Record<string, string> {
  return workspaceToken ? { "X-Motio-Workspace-Token": workspaceToken } : {};
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
  workspaceToken?: string,
): Promise<VideoJob> {
  return request<VideoJob>("/api/video/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionKeyHeaders(sessionApiKey),
      ...localWorkspaceHeaders(workspaceToken),
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export function generateImage(
  payload:
    | { provider: "openrouter"; prompt: string; model: string; inputReference?: string }
    | {
        provider: "mflux";
        prompt: string;
        model: string;
        resolution: string;
        steps: number;
        quantization: number | null;
        seed?: number;
        lowRam: boolean;
        vaeTiling: boolean;
        vaeTileSize: number;
        guidance?: number;
        referenceFit?: LocalH3FrameFitId;
        inputReference?: string;
      },
  sessionApiKey?: string,
  signal?: AbortSignal,
  onMfluxProgress?: (progress: LocalMfluxProgress) => void,
): Promise<ImageGenerationResponse> {
  if (payload.provider === "mflux") {
    return streamMfluxImage(payload, signal, onMfluxProgress);
  }
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

async function streamMfluxImage(
  payload: Extract<Parameters<typeof generateImage>[0], { provider: "mflux" }>,
  signal?: AbortSignal,
  onProgress?: (progress: LocalMfluxProgress) => void,
): Promise<ImageGenerationResponse> {
  let response: Response;
  try {
    response = await fetch("/api/image/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch {
    throw new ApiError("Could not reach the local API. Make sure the backend is running.", 0, true, undefined, "local_network_error");
  }

  if (!response.ok) {
    let body: ApiErrorBody;
    try {
      body = await response.json() as ApiErrorBody;
    } catch {
      throw new ApiError("The local API returned an unreadable response.", response.status, true, undefined, "invalid_local_response");
    }
    throw new ApiError(
      body.error?.message || `The request failed with status ${response.status}.`,
      response.status,
      body.error?.retryable ?? response.status >= 500,
      undefined,
      body.error?.type,
    );
  }
  if (!response.body) throw new ApiError("The local API returned an unreadable response.", response.status, true, undefined, "invalid_local_response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ImageGenerationResponse | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      if (done && buffer) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { type?: string; progress?: LocalMfluxProgress; result?: ImageGenerationResponse; error?: { status: number; type: string; message: string; retryable: boolean } };
        try {
          event = JSON.parse(line);
        } catch {
          throw new ApiError("The local API returned an unreadable response.", response.status, true, undefined, "invalid_local_response");
        }
        if (event.type === "progress" && event.progress) onProgress?.(event.progress);
        else if (event.type === "result" && event.result) result = event.result;
        else if (event.type === "error" && event.error) {
          throw new ApiError(event.error.message, event.error.status, event.error.retryable, undefined, event.error.type);
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("The connection to the local API was interrupted.", 0, true, undefined, "local_network_error");
  }
  if (!result) throw new ApiError("The local API returned an unreadable response.", response.status, true, undefined, "invalid_local_response");
  return result;
}

export function getAppConfig(signal?: AbortSignal): Promise<AppConfig> {
  return request<AppConfig>("/api/config", { signal });
}

export function uploadLocalReferenceImage(
  file: File,
  uploadToken: string,
  workspaceToken: string,
  previousToken?: string,
): Promise<{ path: string; token: string }> {
  return request<{ path: string; token: string }>("/api/local/reference-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Reference-Upload-Token": uploadToken,
      ...localWorkspaceHeaders(workspaceToken),
      ...(previousToken ? { "X-Previous-Reference-Token": previousToken } : {}),
    },
    body: file,
  });
}

export function deleteLocalReferenceImage(token: string, workspaceToken: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>("/api/local/reference-image", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...localWorkspaceHeaders(workspaceToken) },
    body: JSON.stringify({ token }),
  });
}

export function discardLocalWorkspace(
  workspaceToken: string,
  keepalive = false,
  signal?: AbortSignal,
): Promise<{ cleared: true }> {
  return request<{ cleared: true }>("/api/local/workspace", {
    method: "DELETE",
    headers: localWorkspaceHeaders(workspaceToken),
    keepalive,
    signal,
  });
}

export function deleteLocalVideoJob(id: string, workspaceToken: string): Promise<{ deleted: true }> {
  return request<{ deleted: true }>(`/api/local/video/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: localWorkspaceHeaders(workspaceToken),
  });
}

export function getVideoStatus(
  id: string,
  sessionApiKey?: string,
  signal?: AbortSignal,
  workspaceToken?: string,
): Promise<VideoJob> {
  return request<VideoJob>(`/api/video/status/${encodeURIComponent(id)}`, {
    headers: { ...sessionKeyHeaders(sessionApiKey), ...localWorkspaceHeaders(workspaceToken) },
    cache: "no-store",
    signal,
  });
}

export async function getVideoContent(
  url: string,
  sessionApiKey?: string,
  signal?: AbortSignal,
  workspaceToken?: string,
): Promise<Blob> {
  const contentUrl = new URL(url, window.location.origin);
  if (
    contentUrl.origin !== window.location.origin ||
    !contentUrl.pathname.startsWith("/api/video/content/") ||
    contentUrl.search
  ) {
    throw new ApiError("Refused to send session credentials outside the local video endpoint.", 400, false);
  }

  let response: Response;

  try {
    response = await fetch(contentUrl.pathname, {
      headers: { ...sessionKeyHeaders(sessionApiKey), ...localWorkspaceHeaders(workspaceToken) },
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
