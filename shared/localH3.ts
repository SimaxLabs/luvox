export const LOCAL_H3_RESOLUTIONS = [
  { id: "256x256", label: "256 x 256", note: "Fast preview", width: 256, height: 256 },
  { id: "512x512", label: "512 x 512", note: "Validated square", width: 512, height: 512 },
  { id: "864x480", label: "864 x 480", note: "Landscape", width: 864, height: 480 },
  { id: "480x864", label: "480 x 864", note: "Portrait preview", width: 480, height: 864 },
  { id: "576x1024", label: "576 x 1024", note: "Exact 9:16", width: 576, height: 1024 },
] as const;

export const LOCAL_H3_DURATIONS = [
  { frames: 22, label: "0.9 seconds" },
  { frames: 39, label: "1.6 seconds" },
  { frames: 56, label: "2.3 seconds" },
  { frames: 107, label: "4.5 seconds" },
  { frames: 243, label: "10.1 seconds" },
  { frames: 362, label: "15.1 seconds" },
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

export type LocalH3FrameFitId = (typeof LOCAL_H3_FRAME_FIT_IDS)[number];

export function getLocalH3Resolution(id: string) {
  return LOCAL_H3_RESOLUTIONS.find((resolution) => resolution.id === id);
}

export function getLocalH3QualityPreset(id: string) {
  return LOCAL_H3_QUALITY_PRESETS.find((preset) => preset.id === id);
}
