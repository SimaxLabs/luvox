export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface ImageGenerationResponse {
  b64Json: string;
  mediaType: ImageMediaType;
  cost?: number;
}
