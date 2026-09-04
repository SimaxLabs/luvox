export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface ImageGenerationResponse {
  b64Json: string;
  mediaType: ImageMediaType;
  cost?: number;
}

export interface LocalMfluxProgress {
  phase: "loading" | "generating" | "decoding";
  step: number;
  total: number;
  percent: number;
  stepElapsedSeconds?: number;
  etaSeconds?: number;
  secondsPerStep?: number;
}
