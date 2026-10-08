export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface LocalMfluxLora {
  source: string;
  scale: number;
}

export interface ImageGenerationResponse {
  b64Json: string;
  mediaType: ImageMediaType;
  cost?: number;
}

export interface LocalMfluxProgress {
  phase: "checking" | "downloading" | "loading" | "generating" | "decoding";
  step: number;
  total: number;
  percent: number;
  etaSeconds?: number;
  secondsPerStep?: number;
  download?: { completed: number; total: number; unit: "bytes" | "files" };
}
