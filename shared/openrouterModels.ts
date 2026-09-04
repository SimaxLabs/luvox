import type { OpenRouterImageModelConfig } from "./imageModels.js";
import type { VideoModelConfig } from "./videoModels.js";

export interface OpenRouterModelRegistry {
  revision: number;
  images: OpenRouterImageModelConfig[];
  videos: VideoModelConfig[];
  customImageIds: string[];
  customVideoIds: string[];
}

export interface OpenRouterModelsFile {
  version: 1;
  images: OpenRouterImageModelConfig[];
  videos: VideoModelConfig[];
}

export type OpenRouterModelDefinition =
  | { kind: "image"; model: OpenRouterImageModelConfig }
  | { kind: "video"; model: VideoModelConfig };

export type DiscoveredOpenRouterModel =
  | {
      kind: "image";
      description: string;
      providerDefaults: string[];
      model: OpenRouterImageModelConfig;
    }
  | {
      kind: "video";
      description: string;
      providerDefaults: string[];
      model: VideoModelConfig;
    };

export interface OpenRouterDiscoveryResponse {
  models: DiscoveredOpenRouterModel[];
  omitted: number;
}
