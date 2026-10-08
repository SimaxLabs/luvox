export interface OpenRouterImageModelConfig {
  id: string;
  name: string;
  price?: string;
  provider?: {
    id: string;
    name: string;
  };
  outputFormat?: "png" | "jpeg" | "webp";
  aspectRatios: readonly string[];
  defaultAspectRatio: string | null;
  resolutions: readonly string[];
  defaultResolution: string | null;
  inputReference: {
    supported: boolean;
    required: boolean;
  };
}

export const MUSE_IMAGE_MODEL = {
  id: "meta/muse-image",
  name: "Meta: Muse Image",
  price: "$0.01/image",
  aspectRatios: [],
  defaultAspectRatio: null,
  resolutions: [],
  defaultResolution: null,
  inputReference: {
    supported: true,
    required: false,
  },
} as const satisfies OpenRouterImageModelConfig;

export const OPENROUTER_IMAGE_MODELS = [MUSE_IMAGE_MODEL] as const satisfies readonly OpenRouterImageModelConfig[];

export const MFLUX_IMAGE_RESOLUTIONS = [
  { id: "1024x1024", label: "1024p", aspectRatio: "1:1", width: 1_024, height: 1_024 },
  { id: "1280x720", label: "720p", aspectRatio: "16:9", width: 1_280, height: 720 },
  { id: "720x1280", label: "720p", aspectRatio: "9:16", width: 720, height: 1_280 },
  { id: "1152x864", label: "864p", aspectRatio: "4:3", width: 1_152, height: 864 },
  { id: "864x1152", label: "864p", aspectRatio: "3:4", width: 864, height: 1_152 },
  { id: "1248x832", label: "832p", aspectRatio: "3:2", width: 1_248, height: 832 },
  { id: "832x1248", label: "832p", aspectRatio: "2:3", width: 832, height: 1_248 },
] as const;

export const MFLUX_IMAGE_QUANTIZATIONS = [null, 8, 6, 5, 4, 3] as const;
export const MFLUX_VAE_TILE_SIZES = [128, 256, 512] as const;
export const MFLUX_Z_IMAGE_REFERENCE_STRENGTH = 0.4;
export const MFLUX_LORA_LIMITS = { count: 4, sourceLength: 1_024, minScale: -2, maxScale: 2, defaultScale: 1 } as const;

export const MFLUX_IMAGE_MODEL = {
  id: "z-image-turbo",
  name: "Z-Image Turbo",
  executable: "mflux-generate-z-image-turbo",
  environmentVariable: "MFLUX_Z_IMAGE_TURBO_BINARY",
  steps: [4, 6, 9],
} as const;

export const MFLUX_IMAGE_MODELS = [
  MFLUX_IMAGE_MODEL,
  {
    id: "flux2-klein-4b",
    name: "FLUX.2 Klein 4B",
    executable: "mflux-generate-flux2",
    referenceExecutable: "mflux-generate-flux2-edit",
    environmentVariable: "MFLUX_FLUX2_BINARY",
    steps: [1, 2, 3, 4],
  },
] as const;

const recommendedDefaults = {
  resolution: MFLUX_IMAGE_RESOLUTIONS[0].id,
  lowRam: false,
  vaeTiling: false,
  vaeTileSize: 512,
} as const;

export const MFLUX_IMAGE_RECOMMENDED_SETUPS = [
  {
    ...recommendedDefaults,
    id: "z-image-standard",
    label: "Standard",
    note: "1024p / 1:1, 9 steps, 8-bit",
    models: ["z-image-turbo"],
    steps: 9,
    quantization: 8,
  },
  {
    ...recommendedDefaults,
    id: "quality",
    label: "Quality",
    note: "1024p / 1:1, 4 steps, 8-bit",
    models: ["flux2-klein-4b"],
    steps: 4,
    quantization: 8,
  },
  {
    ...recommendedDefaults,
    id: "fast",
    label: "Fast",
    note: "1024p / 1:1, 4 steps, 4-bit",
    models: ["flux2-klein-4b"],
    steps: 4,
    quantization: 4,
  },
  {
    ...recommendedDefaults,
    id: "z-image-fast",
    label: "Fast",
    note: "1024p / 1:1, 9 steps, 4-bit",
    models: ["z-image-turbo"],
    steps: 9,
    quantization: 4,
  },
] as const;

export function getMfluxImageModel(id: string) {
  return MFLUX_IMAGE_MODELS.find((model) => model.id === id);
}

export function getMfluxImageResolution(id: string) {
  return MFLUX_IMAGE_RESOLUTIONS.find((resolution) => resolution.id === id);
}

export function getMfluxInferenceSteps(model: string, steps: number, hasReference: boolean): number {
  // MFLUX starts image-to-image partway through the selected schedule.
  return model === "z-image-turbo" && hasReference
    ? steps - Math.max(1, Math.floor(steps * MFLUX_Z_IMAGE_REFERENCE_STRENGTH))
    : steps;
}
