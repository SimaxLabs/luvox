export type GenerationStatus = "queued" | "processing" | "completed" | "failed";

export interface VideoJob {
  id: string;
  status: GenerationStatus;
  error?: string;
  videoUrl?: string;
  downloadUrl?: string;
  cost?: number;
}

export interface GenerateVideoPayload {
  prompt: string;
  model: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  generateAudio?: boolean;
}

interface ApiErrorBody {
  error?: {
    message?: string;
    retryable?: boolean;
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

export function generateVideo(payload: GenerateVideoPayload): Promise<VideoJob> {
  return request<VideoJob>("/api/video/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getVideoStatus(id: string, signal?: AbortSignal): Promise<VideoJob> {
  return request<VideoJob>(`/api/video/status/${encodeURIComponent(id)}`, { signal });
}
