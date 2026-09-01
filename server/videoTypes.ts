export type VideoProvider = "openrouter" | "local";
export type GenerationStatus = "queued" | "processing" | "completed" | "failed";

export interface VideoStatusResponse {
  id: string;
  provider: VideoProvider;
  status: GenerationStatus;
  error?: string;
  videoUrl?: string;
  downloadUrl?: string;
  cost?: number;
  phase?: string;
  progress?: number;
}
