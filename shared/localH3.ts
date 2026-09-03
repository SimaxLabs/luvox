export const LOCAL_H3_RESOLUTIONS = [
  { id: "256x256", label: "256p", aspectRatio: "1:1", width: 256, height: 256 },
  { id: "864x480", label: "480p", aspectRatio: "16:9", width: 864, height: 480 },
  { id: "480x864", label: "480p", aspectRatio: "9:16", width: 480, height: 864 },
  { id: "512x512", label: "512p", aspectRatio: "1:1", width: 512, height: 512 },
  { id: "576x1024", label: "576p", aspectRatio: "9:16", width: 576, height: 1024 },
] as const;

export const LOCAL_H3_DURATIONS = [
  { frames: 22, label: "0.9 s" },
  { frames: 39, label: "1.6 s" },
  { frames: 56, label: "2.3 s" },
  { frames: 107, label: "4.5 s" },
  { frames: 243, label: "10.1 s" },
  { frames: 362, label: "15.1 s" },
] as const;

export const LOCAL_H3_FRAME_FIT_IDS = ["contain", "cover"] as const;

export const LOCAL_H3_FRAME_FITS = [
  { id: "contain", label: "Preserve full image", note: "Keeps every part of the image without distortion and pads the unused canvas." },
  { id: "cover", label: "Crop to fill", note: "Fills the video without distortion by cropping image edges." },
] as const;

export const LOCAL_H3_QUALITY_PRESETS = [
  {
    id: "draft",
    label: "Draft",
    note: "4 passes for quick iteration",
    steps: 4,
    layers: 50,
    reuse: 1,
  },
  {
    id: "balanced",
    label: "Balanced",
    note: "Validated speed and quality preset",
    steps: 20,
    layers: 45,
    reuse: 2,
  },
  {
    id: "quality",
    label: "Quality",
    note: "50-pass reference path",
    steps: 50,
    layers: 50,
    reuse: 1,
  },
] as const;

interface LocalH3AccelerationPreset {
  id: string;
  label: string;
  note: string;
  resolution?: string;
  quality?: string;
  tokenReduction?: boolean;
  renderWidth?: number;
  renderHeight?: number;
}

export const LOCAL_H3_ACCELERATION_PRESETS = [
  {
    id: "standard",
    label: "Standard",
    note: "Full tokens and a native-size internal canvas.",
  },
  {
    id: "reduced-tokens",
    label: "Reduced tokens",
    note: "Faster denoising with a possible change in composition.",
    resolution: "512x512",
    quality: "balanced",
    tokenReduction: true,
  },
  {
    id: "fast-canvas",
    label: "Fast canvas",
    note: "Uses a smaller square canvas, then upscales to 512p.",
    resolution: "512x512",
    quality: "balanced",
    renderWidth: 384,
    renderHeight: 384,
  },
] as const satisfies readonly LocalH3AccelerationPreset[];

export const LOCAL_H3_RECOMMENDED_SETUPS = [
  {
    id: "validated-fast",
    label: "Stable",
    note: "Balanced with reduced tokens",
    resolution: "512x512",
    frames: 22,
    quality: "balanced",
    acceleration: "reduced-tokens",
    seed: 42,
    ssdStreaming: false,
  },
  {
    id: "reference-quality",
    label: "Quality",
    note: "50-pass quality path",
    resolution: "512x512",
    frames: 22,
    quality: "quality",
    acceleration: "standard",
    seed: 42,
    ssdStreaming: false,
  },
] as const;

export type LocalH3FrameFitId = (typeof LOCAL_H3_FRAME_FIT_IDS)[number];

export function getLocalH3Resolution(id: string) {
  return LOCAL_H3_RESOLUTIONS.find((resolution) => resolution.id === id);
}

export function getLocalH3QualityPreset(id: string) {
  return LOCAL_H3_QUALITY_PRESETS.find((preset) => preset.id === id);
}

export function getLocalH3AccelerationPreset(id: string): LocalH3AccelerationPreset | undefined {
  return LOCAL_H3_ACCELERATION_PRESETS.find((preset) => preset.id === id);
}

export function isLocalH3AccelerationAvailable(id: string, resolution: string, quality: string) {
  const preset: LocalH3AccelerationPreset | undefined = getLocalH3AccelerationPreset(id);
  return Boolean(
    preset &&
    (!preset.resolution || preset.resolution === resolution) &&
    (!preset.quality || preset.quality === quality),
  );
}
