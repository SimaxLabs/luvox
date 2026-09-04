export const MUSE_IMAGE_MODEL = {
  id: "meta/muse-image",
  name: "Meta: Muse Image",
  price: "$0.01/image",
} as const;

export const MFLUX_IMAGE_RESOLUTIONS = [
  { id: "1024x1024", label: "1024p", aspectRatio: "1:1", width: 1_024, height: 1_024 },
  { id: "1280x720", label: "720p", aspectRatio: "16:9", width: 1_280, height: 720 },
  { id: "720x1280", label: "720p", aspectRatio: "9:16", width: 720, height: 1_280 },
  { id: "1152x864", label: "864p", aspectRatio: "4:3", width: 1_152, height: 864 },
  { id: "864x1152", label: "864p", aspectRatio: "3:4", width: 864, height: 1_152 },
  { id: "1248x832", label: "832p", aspectRatio: "3:2", width: 1_248, height: 832 },
  { id: "832x1248", label: "832p", aspectRatio: "2:3", width: 832, height: 1_248 },
] as const;

const MFLUX_FLUX2_STEPS = [1, 2, 3, 4] as const;
const MFLUX_QWEN_EDIT_STEPS = [20, 30] as const;
export const MFLUX_IMAGE_STEPS = [...MFLUX_FLUX2_STEPS, ...MFLUX_QWEN_EDIT_STEPS] as const;
export const MFLUX_IMAGE_QUANTIZATIONS = [null, 8, 6, 5, 4, 3] as const;
export const MFLUX_VAE_TILE_SIZES = [128, 256, 512] as const;
export const MFLUX_QWEN_EDIT_GUIDANCE = 2.5;

export const MFLUX_IMAGE_MODEL = {
  id: "qwen-image-edit",
  name: "Qwen Image Edit",
  executable: "mflux-generate-qwen-edit",
  environmentVariable: "MFLUX_QWEN_EDIT_BINARY",
  steps: MFLUX_QWEN_EDIT_STEPS,
  requiresReference: true,
} as const;

export const MFLUX_IMAGE_MODELS = [
  MFLUX_IMAGE_MODEL,
  {
    id: "flux2-klein-4b",
    name: "FLUX.2 Klein 4B",
    executable: "mflux-generate-flux2",
    referenceExecutable: "mflux-generate-flux2-edit",
    environmentVariable: "MFLUX_FLUX2_BINARY",
    steps: MFLUX_FLUX2_STEPS,
    requiresReference: false,
  },
] as const;

export const MFLUX_IMAGE_RECOMMENDED_SETUPS = [
  {
    id: "qwen-standard",
    label: "Standard",
    note: "1024p / 1:1, 20 steps, 8-bit",
    models: ["qwen-image-edit"],
    resolution: MFLUX_IMAGE_RESOLUTIONS[0].id,
    steps: 20,
    quantization: 8,
    seed: null,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
    guidance: MFLUX_QWEN_EDIT_GUIDANCE,
  },
  {
    id: "quality",
    label: "Quality",
    note: "1024p / 1:1, 4 steps, 8-bit",
    models: ["flux2-klein-4b"],
    resolution: MFLUX_IMAGE_RESOLUTIONS[0].id,
    steps: 4,
    quantization: 8,
    seed: null,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
    guidance: MFLUX_QWEN_EDIT_GUIDANCE,
  },
  {
    id: "fast",
    label: "Fast",
    note: "1024p / 1:1, 4 steps, 4-bit",
    models: ["flux2-klein-4b"],
    resolution: MFLUX_IMAGE_RESOLUTIONS[0].id,
    steps: 4,
    quantization: 4,
    seed: null,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
    guidance: MFLUX_QWEN_EDIT_GUIDANCE,
  },
  {
    id: "qwen-quality",
    label: "Quality",
    note: "1024p / 1:1, 30 steps, 8-bit",
    models: ["qwen-image-edit"],
    resolution: MFLUX_IMAGE_RESOLUTIONS[0].id,
    steps: 30,
    quantization: 8,
    seed: null,
    lowRam: false,
    vaeTiling: false,
    vaeTileSize: 512,
    guidance: MFLUX_QWEN_EDIT_GUIDANCE,
  },
] as const;

export function getMfluxImageModel(id: string) {
  return MFLUX_IMAGE_MODELS.find((model) => model.id === id);
}

export function getMfluxImageResolution(id: string) {
  return MFLUX_IMAGE_RESOLUTIONS.find((resolution) => resolution.id === id);
}
