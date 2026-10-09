export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export function rasterMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return "image/png";
  if ([0xff, 0xd8, 0xff].every((byte, index) => bytes[index] === byte)) return "image/jpeg";
  if (
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  return undefined;
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
