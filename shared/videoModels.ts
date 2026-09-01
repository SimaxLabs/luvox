export interface VideoModelConfig {
  id: string;
  name: string;
  durations: readonly number[];
  defaultDuration: number;
  aspectRatios: readonly string[];
  defaultAspectRatio: string;
  resolutions: readonly string[];
  defaultResolution?: string;
  frameImages: {
    supported: readonly ("first_frame" | "last_frame")[];
    input: "public_url" | "none";
  };
  generateAudio: {
    supported: boolean;
    default: boolean;
  };
}

export const DEFAULT_MODEL_ID = "minimax/hailuo-3";

// Keep model-specific request controls here. Both the UI and API validation use
// this data, so adding a model does not require duplicating its capabilities.
export const VIDEO_MODELS = [
  {
    id: DEFAULT_MODEL_ID,
    name: "MiniMax: Hailuo 3",
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 6,
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    defaultAspectRatio: "16:9",
    resolutions: ["2K"],
    defaultResolution: "2K",
    frameImages: {
      supported: ["first_frame", "last_frame"],
      input: "public_url",
    },
    generateAudio: {
      supported: true,
      default: true,
    },
  },
] as const satisfies readonly VideoModelConfig[];

export function getVideoModel(modelId: string): VideoModelConfig | undefined {
  return VIDEO_MODELS.find((model) => model.id === modelId);
}
