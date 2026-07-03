export const ZOOM_PERCENT_LADDER = [
  67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300,
] as const;

export type ZoomPercent = (typeof ZOOM_PERCENT_LADDER)[number];
