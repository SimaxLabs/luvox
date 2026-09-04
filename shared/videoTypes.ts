export type GenerationStatus = "queued" | "processing" | "completed" | "failed";

export interface VideoStatusResponse {
  id: string;
  provider: "openrouter" | "local";
  status: GenerationStatus;
  capabilityToken?: string;
  error?: string;
  videoUrl?: string;
  downloadUrl?: string;
  cost?: number;
  phase?: string;
  progress?: number;
}
