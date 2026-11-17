/**
 * The exact layers of a blob wearing shades, and a visor, looking ahead, in
 * the default colours at 16 and 32 px, as drawn before glasses became wide
 * eyes. Eyewear other than glasses must not move.
 */
export interface PinnedLayer {
  readonly fill: string;
  readonly path: string;
}

export const BLOB_SHADES16: readonly PinnedLayer[] = [
  {
    fill: "hsl(195 24% 80%)",
    path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
  },
  {
    fill: "hsl(192 32% 68%)",
    path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
  },
  {
    fill: "hsl(189 32% 57%)",
    path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
  },
  {
    fill: "hsl(192 30% 97%)",
    path: "M3 7h2v2h-2z",
  },
  {
    fill: "hsl(220 12% 7%)",
    path: "M5 7h2v2h-2zM7 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
  },
  {
    fill: "hsl(186 32% 46%)",
    path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
  },
];

export const BLOB_SHADES32: readonly PinnedLayer[] = [
  {
    fill: "hsl(189 32% 57%)",
    path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
  },
  {
    fill: "hsl(198 12% 92%)",
    path: "M10 10h3v3h-3zM13 10h3v3h-3z",
  },
  {
    fill: "hsl(192 32% 68%)",
    path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
  },
  {
    fill: "hsl(195 24% 80%)",
    path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
  },
  {
    fill: "hsl(186 32% 46%)",
    path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
  },
  {
    fill: "hsl(192 30% 97%)",
    path: "M7 16h3v3h-3zM19 16h3v3h-3z",
  },
  {
    fill: "hsl(220 12% 7%)",
    path: "M10 16h3v3h-3zM13 16h3v3h-3zM16 16h3v3h-3zM22 16h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3z",
  },
];

export const BLOB_VISOR16: readonly PinnedLayer[] = [
  {
    fill: "hsl(195 24% 80%)",
    path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
  },
  {
    fill: "hsl(192 32% 68%)",
    path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
  },
  {
    fill: "hsl(189 32% 57%)",
    path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
  },
  {
    fill: "hsl(220 12% 7%)",
    path: "M3 7h2v2h-2zM7 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
  },
  {
    fill: "hsl(192 30% 97%)",
    path: "M5 7h2v2h-2z",
  },
  {
    fill: "hsl(186 32% 46%)",
    path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
  },
];

export const BLOB_VISOR32: readonly PinnedLayer[] = [
  {
    fill: "hsl(189 32% 57%)",
    path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
  },
  {
    fill: "hsl(198 12% 92%)",
    path: "M10 10h3v3h-3zM13 10h3v3h-3z",
  },
  {
    fill: "hsl(192 32% 68%)",
    path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
  },
  {
    fill: "hsl(195 24% 80%)",
    path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
  },
  {
    fill: "hsl(186 32% 46%)",
    path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
  },
  {
    fill: "hsl(220 12% 7%)",
    path: "M7 16h3v3h-3zM13 16h3v3h-3zM16 16h3v3h-3zM19 16h3v3h-3zM22 16h3v3h-3z",
  },
  {
    fill: "hsl(192 30% 97%)",
    path: "M10 16h3v3h-3z",
  },
];

/**
 * The exact layers of a blob wearing shades or a visor in the poses that did
 * not change when shades learned to peek: the smallest size's shades on each
 * beat of working, large shades idle and shut, and the visor on each beat of
 * working at every size.
 */
export interface PinnedPose {
  readonly eyewear: "shades" | "visor";
  readonly size: 16 | 24 | 32 | 40;
  readonly expression: "idle" | "working" | "away";
  readonly beat: number;
  readonly layers: readonly PinnedLayer[];
}

export const BLOB_UNCHANGED_POSES: readonly PinnedPose[] = [
  {
    eyewear: "shades",
    size: 16,
    expression: "working",
    beat: 0,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M3 7h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M5 7h2v2h-2zM7 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 16,
    expression: "working",
    beat: 1,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM7 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M5 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 16,
    expression: "working",
    beat: 2,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM5 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M7 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 16,
    expression: "working",
    beat: 3,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM5 7h2v2h-2zM7 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M9 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 24,
    expression: "idle",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM2 10h2v2h-2zM20 10h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM8 18h2v2h-2zM10 18h2v2h-2zM12 18h2v2h-2zM14 18h2v2h-2zM16 18h2v2h-2zM18 18h2v2h-2z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M8 8h2v2h-2zM10 8h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M12 8h2v2h-2zM14 8h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM4 12h2v2h-2zM18 12h2v2h-2zM4 14h2v2h-2zM18 14h2v2h-2zM4 16h2v2h-2zM18 16h2v2h-2z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM6 16h2v2h-2zM8 16h2v2h-2zM10 16h2v2h-2zM12 16h2v2h-2zM14 16h2v2h-2zM16 16h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M2 12h2v2h-2zM20 12h2v2h-2zM2 14h2v2h-2zM20 14h2v2h-2zM2 16h2v2h-2zM20 16h2v2h-2zM2 18h2v2h-2zM20 18h2v2h-2zM4 20h2v2h-2zM6 20h2v2h-2zM8 20h2v2h-2zM10 20h2v2h-2zM12 20h2v2h-2zM14 20h2v2h-2zM16 20h2v2h-2zM18 20h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M6 12h2v2h-2zM14 12h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M8 12h2v2h-2zM10 12h2v2h-2zM12 12h2v2h-2zM16 12h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 40,
    expression: "idle",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M12 8h4v4h-4zM16 8h4v4h-4zM20 8h4v4h-4zM24 8h4v4h-4zM4 12h4v4h-4zM8 12h4v4h-4zM28 12h4v4h-4zM32 12h4v4h-4zM0 16h4v4h-4zM36 16h4v4h-4zM4 32h4v4h-4zM8 32h4v4h-4zM12 32h4v4h-4zM16 32h4v4h-4zM20 32h4v4h-4zM24 32h4v4h-4zM28 32h4v4h-4zM32 32h4v4h-4z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M12 12h4v4h-4zM16 12h4v4h-4z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M20 12h4v4h-4zM24 12h4v4h-4zM4 16h4v4h-4zM8 16h4v4h-4zM28 16h4v4h-4zM32 16h4v4h-4zM4 20h4v4h-4zM32 20h4v4h-4zM4 24h4v4h-4zM32 24h4v4h-4zM4 28h4v4h-4zM32 28h4v4h-4z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M12 16h4v4h-4zM16 16h4v4h-4zM20 16h4v4h-4zM24 16h4v4h-4zM16 24h4v4h-4zM20 24h4v4h-4zM8 28h4v4h-4zM12 28h4v4h-4zM16 28h4v4h-4zM20 28h4v4h-4zM24 28h4v4h-4zM28 28h4v4h-4z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M0 20h4v4h-4zM36 20h4v4h-4zM0 24h4v4h-4zM36 24h4v4h-4zM0 28h4v4h-4zM36 28h4v4h-4zM0 32h4v4h-4zM36 32h4v4h-4zM4 36h4v4h-4zM8 36h4v4h-4zM12 36h4v4h-4zM16 36h4v4h-4zM20 36h4v4h-4zM24 36h4v4h-4zM28 36h4v4h-4zM32 36h4v4h-4z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M8 20h4v4h-4zM24 20h4v4h-4z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M12 20h4v4h-4zM16 20h4v4h-4zM20 20h4v4h-4zM28 20h4v4h-4zM8 24h4v4h-4zM12 24h4v4h-4zM24 24h4v4h-4zM28 24h4v4h-4z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 24,
    expression: "away",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM2 10h2v2h-2zM20 10h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM8 18h2v2h-2zM10 18h2v2h-2zM12 18h2v2h-2zM14 18h2v2h-2zM16 18h2v2h-2zM18 18h2v2h-2z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M8 8h2v2h-2zM10 8h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M12 8h2v2h-2zM14 8h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM4 12h2v2h-2zM18 12h2v2h-2zM4 14h2v2h-2zM18 14h2v2h-2zM4 16h2v2h-2zM18 16h2v2h-2z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM6 16h2v2h-2zM8 16h2v2h-2zM10 16h2v2h-2zM12 16h2v2h-2zM14 16h2v2h-2zM16 16h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M2 12h2v2h-2zM20 12h2v2h-2zM2 14h2v2h-2zM20 14h2v2h-2zM2 16h2v2h-2zM20 16h2v2h-2zM2 18h2v2h-2zM20 18h2v2h-2zM4 20h2v2h-2zM6 20h2v2h-2zM8 20h2v2h-2zM10 20h2v2h-2zM12 20h2v2h-2zM14 20h2v2h-2zM16 20h2v2h-2zM18 20h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M6 12h2v2h-2zM8 12h2v2h-2zM10 12h2v2h-2zM12 12h2v2h-2zM14 12h2v2h-2zM16 12h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 32,
    expression: "away",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M10 10h3v3h-3zM13 10h3v3h-3z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M7 16h3v3h-3zM10 16h3v3h-3zM13 16h3v3h-3zM16 16h3v3h-3zM19 16h3v3h-3zM22 16h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3z",
      },
    ],
  },
  {
    eyewear: "shades",
    size: 40,
    expression: "away",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M12 8h4v4h-4zM16 8h4v4h-4zM20 8h4v4h-4zM24 8h4v4h-4zM4 12h4v4h-4zM8 12h4v4h-4zM28 12h4v4h-4zM32 12h4v4h-4zM0 16h4v4h-4zM36 16h4v4h-4zM4 32h4v4h-4zM8 32h4v4h-4zM12 32h4v4h-4zM16 32h4v4h-4zM20 32h4v4h-4zM24 32h4v4h-4zM28 32h4v4h-4zM32 32h4v4h-4z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M12 12h4v4h-4zM16 12h4v4h-4z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M20 12h4v4h-4zM24 12h4v4h-4zM4 16h4v4h-4zM8 16h4v4h-4zM28 16h4v4h-4zM32 16h4v4h-4zM4 20h4v4h-4zM32 20h4v4h-4zM4 24h4v4h-4zM32 24h4v4h-4zM4 28h4v4h-4zM32 28h4v4h-4z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M12 16h4v4h-4zM16 16h4v4h-4zM20 16h4v4h-4zM24 16h4v4h-4zM16 24h4v4h-4zM20 24h4v4h-4zM8 28h4v4h-4zM12 28h4v4h-4zM16 28h4v4h-4zM20 28h4v4h-4zM24 28h4v4h-4zM28 28h4v4h-4z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M0 20h4v4h-4zM36 20h4v4h-4zM0 24h4v4h-4zM36 24h4v4h-4zM0 28h4v4h-4zM36 28h4v4h-4zM0 32h4v4h-4zM36 32h4v4h-4zM4 36h4v4h-4zM8 36h4v4h-4zM12 36h4v4h-4zM16 36h4v4h-4zM20 36h4v4h-4zM24 36h4v4h-4zM28 36h4v4h-4zM32 36h4v4h-4z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M8 20h4v4h-4zM12 20h4v4h-4zM16 20h4v4h-4zM20 20h4v4h-4zM24 20h4v4h-4zM28 20h4v4h-4zM8 24h4v4h-4zM12 24h4v4h-4zM24 24h4v4h-4zM28 24h4v4h-4z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 16,
    expression: "working",
    beat: 0,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM7 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M5 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 16,
    expression: "working",
    beat: 1,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM5 7h2v2h-2zM9 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M7 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 16,
    expression: "working",
    beat: 2,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM5 7h2v2h-2zM7 7h2v2h-2zM11 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M9 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 16,
    expression: "working",
    beat: 3,
    layers: [
      {
        fill: "hsl(195 24% 80%)",
        path: "M3 3h2v2h-2zM5 3h2v2h-2zM7 3h2v2h-2zM9 3h2v2h-2zM11 3h2v2h-2zM1 5h2v2h-2zM13 5h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M3 5h2v2h-2zM5 5h2v2h-2zM7 5h2v2h-2zM9 5h2v2h-2zM11 5h2v2h-2zM3 9h2v2h-2zM5 9h2v2h-2zM7 9h2v2h-2zM9 9h2v2h-2zM11 9h2v2h-2zM3 11h2v2h-2zM5 11h2v2h-2zM7 11h2v2h-2zM9 11h2v2h-2zM11 11h2v2h-2z",
      },
      {
        fill: "hsl(189 32% 57%)",
        path: "M1 7h2v2h-2zM13 7h2v2h-2zM1 9h2v2h-2zM13 9h2v2h-2zM1 11h2v2h-2zM13 11h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M3 7h2v2h-2zM5 7h2v2h-2zM7 7h2v2h-2zM9 7h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M11 7h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M3 13h2v2h-2zM5 13h2v2h-2zM7 13h2v2h-2zM9 13h2v2h-2zM11 13h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 24,
    expression: "working",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM2 10h2v2h-2zM20 10h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM8 18h2v2h-2zM10 18h2v2h-2zM12 18h2v2h-2zM14 18h2v2h-2zM16 18h2v2h-2zM18 18h2v2h-2z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M8 8h2v2h-2zM10 8h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M12 8h2v2h-2zM14 8h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM4 12h2v2h-2zM18 12h2v2h-2zM4 14h2v2h-2zM18 14h2v2h-2zM4 16h2v2h-2zM18 16h2v2h-2z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2zM6 16h2v2h-2zM8 16h2v2h-2zM10 16h2v2h-2zM12 16h2v2h-2zM14 16h2v2h-2zM16 16h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M2 12h2v2h-2zM20 12h2v2h-2zM2 14h2v2h-2zM20 14h2v2h-2zM2 16h2v2h-2zM20 16h2v2h-2zM2 18h2v2h-2zM20 18h2v2h-2zM4 20h2v2h-2zM6 20h2v2h-2zM8 20h2v2h-2zM10 20h2v2h-2zM12 20h2v2h-2zM14 20h2v2h-2zM16 20h2v2h-2zM18 20h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M6 12h2v2h-2zM10 12h2v2h-2zM12 12h2v2h-2zM14 12h2v2h-2zM16 12h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M8 12h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 24,
    expression: "working",
    beat: 1,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM2 10h2v2h-2zM20 10h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM8 18h2v2h-2zM10 18h2v2h-2zM12 18h2v2h-2zM14 18h2v2h-2zM16 18h2v2h-2zM18 18h2v2h-2z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M8 8h2v2h-2zM10 8h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M12 8h2v2h-2zM14 8h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM4 12h2v2h-2zM18 12h2v2h-2zM4 14h2v2h-2zM18 14h2v2h-2zM4 16h2v2h-2zM18 16h2v2h-2z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2zM6 16h2v2h-2zM8 16h2v2h-2zM10 16h2v2h-2zM12 16h2v2h-2zM14 16h2v2h-2zM16 16h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M2 12h2v2h-2zM20 12h2v2h-2zM2 14h2v2h-2zM20 14h2v2h-2zM2 16h2v2h-2zM20 16h2v2h-2zM2 18h2v2h-2zM20 18h2v2h-2zM4 20h2v2h-2zM6 20h2v2h-2zM8 20h2v2h-2zM10 20h2v2h-2zM12 20h2v2h-2zM14 20h2v2h-2zM16 20h2v2h-2zM18 20h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M6 12h2v2h-2zM8 12h2v2h-2zM12 12h2v2h-2zM14 12h2v2h-2zM16 12h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M10 12h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 24,
    expression: "working",
    beat: 2,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM2 10h2v2h-2zM20 10h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM8 18h2v2h-2zM10 18h2v2h-2zM12 18h2v2h-2zM14 18h2v2h-2zM16 18h2v2h-2zM18 18h2v2h-2z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M8 8h2v2h-2zM10 8h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M12 8h2v2h-2zM14 8h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM4 12h2v2h-2zM18 12h2v2h-2zM4 14h2v2h-2zM18 14h2v2h-2zM4 16h2v2h-2zM18 16h2v2h-2z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2zM6 16h2v2h-2zM8 16h2v2h-2zM10 16h2v2h-2zM12 16h2v2h-2zM14 16h2v2h-2zM16 16h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M2 12h2v2h-2zM20 12h2v2h-2zM2 14h2v2h-2zM20 14h2v2h-2zM2 16h2v2h-2zM20 16h2v2h-2zM2 18h2v2h-2zM20 18h2v2h-2zM4 20h2v2h-2zM6 20h2v2h-2zM8 20h2v2h-2zM10 20h2v2h-2zM12 20h2v2h-2zM14 20h2v2h-2zM16 20h2v2h-2zM18 20h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M6 12h2v2h-2zM8 12h2v2h-2zM10 12h2v2h-2zM14 12h2v2h-2zM16 12h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M12 12h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 24,
    expression: "working",
    beat: 3,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M8 6h2v2h-2zM10 6h2v2h-2zM12 6h2v2h-2zM14 6h2v2h-2zM4 8h2v2h-2zM6 8h2v2h-2zM16 8h2v2h-2zM18 8h2v2h-2zM2 10h2v2h-2zM20 10h2v2h-2zM4 18h2v2h-2zM6 18h2v2h-2zM8 18h2v2h-2zM10 18h2v2h-2zM12 18h2v2h-2zM14 18h2v2h-2zM16 18h2v2h-2zM18 18h2v2h-2z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M8 8h2v2h-2zM10 8h2v2h-2z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M12 8h2v2h-2zM14 8h2v2h-2zM4 10h2v2h-2zM6 10h2v2h-2zM16 10h2v2h-2zM18 10h2v2h-2zM4 12h2v2h-2zM18 12h2v2h-2zM4 14h2v2h-2zM18 14h2v2h-2zM4 16h2v2h-2zM18 16h2v2h-2z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M8 10h2v2h-2zM10 10h2v2h-2zM12 10h2v2h-2zM14 10h2v2h-2zM6 14h2v2h-2zM8 14h2v2h-2zM10 14h2v2h-2zM12 14h2v2h-2zM14 14h2v2h-2zM16 14h2v2h-2zM6 16h2v2h-2zM8 16h2v2h-2zM10 16h2v2h-2zM12 16h2v2h-2zM14 16h2v2h-2zM16 16h2v2h-2z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M2 12h2v2h-2zM20 12h2v2h-2zM2 14h2v2h-2zM20 14h2v2h-2zM2 16h2v2h-2zM20 16h2v2h-2zM2 18h2v2h-2zM20 18h2v2h-2zM4 20h2v2h-2zM6 20h2v2h-2zM8 20h2v2h-2zM10 20h2v2h-2zM12 20h2v2h-2zM14 20h2v2h-2zM16 20h2v2h-2zM18 20h2v2h-2z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M6 12h2v2h-2zM8 12h2v2h-2zM10 12h2v2h-2zM12 12h2v2h-2zM16 12h2v2h-2z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M14 12h2v2h-2z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 32,
    expression: "working",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M10 10h3v3h-3zM13 10h3v3h-3z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M7 16h3v3h-3zM13 16h3v3h-3zM16 16h3v3h-3zM19 16h3v3h-3zM22 16h3v3h-3z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M10 16h3v3h-3z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 32,
    expression: "working",
    beat: 1,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M10 10h3v3h-3zM13 10h3v3h-3z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M7 16h3v3h-3zM10 16h3v3h-3zM16 16h3v3h-3zM19 16h3v3h-3zM22 16h3v3h-3z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M13 16h3v3h-3z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 32,
    expression: "working",
    beat: 2,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M10 10h3v3h-3zM13 10h3v3h-3z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M7 16h3v3h-3zM10 16h3v3h-3zM13 16h3v3h-3zM19 16h3v3h-3zM22 16h3v3h-3z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M16 16h3v3h-3z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 32,
    expression: "working",
    beat: 3,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M10 7h3v3h-3zM13 7h3v3h-3zM16 7h3v3h-3zM19 7h3v3h-3zM4 10h3v3h-3zM7 10h3v3h-3zM22 10h3v3h-3zM25 10h3v3h-3zM1 13h3v3h-3zM28 13h3v3h-3zM4 25h3v3h-3zM7 25h3v3h-3zM10 25h3v3h-3zM13 25h3v3h-3zM16 25h3v3h-3zM19 25h3v3h-3zM22 25h3v3h-3zM25 25h3v3h-3z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M10 10h3v3h-3zM13 10h3v3h-3z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M16 10h3v3h-3zM19 10h3v3h-3zM4 13h3v3h-3zM7 13h3v3h-3zM22 13h3v3h-3zM25 13h3v3h-3zM4 16h3v3h-3zM25 16h3v3h-3zM4 19h3v3h-3zM25 19h3v3h-3zM4 22h3v3h-3zM25 22h3v3h-3z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M10 13h3v3h-3zM13 13h3v3h-3zM16 13h3v3h-3zM19 13h3v3h-3zM7 19h3v3h-3zM10 19h3v3h-3zM13 19h3v3h-3zM16 19h3v3h-3zM19 19h3v3h-3zM22 19h3v3h-3zM7 22h3v3h-3zM10 22h3v3h-3zM13 22h3v3h-3zM16 22h3v3h-3zM19 22h3v3h-3zM22 22h3v3h-3z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M1 16h3v3h-3zM28 16h3v3h-3zM1 19h3v3h-3zM28 19h3v3h-3zM1 22h3v3h-3zM28 22h3v3h-3zM1 25h3v3h-3zM28 25h3v3h-3zM4 28h3v3h-3zM7 28h3v3h-3zM10 28h3v3h-3zM13 28h3v3h-3zM16 28h3v3h-3zM19 28h3v3h-3zM22 28h3v3h-3zM25 28h3v3h-3z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M7 16h3v3h-3zM10 16h3v3h-3zM13 16h3v3h-3zM16 16h3v3h-3zM22 16h3v3h-3z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M19 16h3v3h-3z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 40,
    expression: "working",
    beat: 0,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M12 8h4v4h-4zM16 8h4v4h-4zM20 8h4v4h-4zM24 8h4v4h-4zM4 12h4v4h-4zM8 12h4v4h-4zM28 12h4v4h-4zM32 12h4v4h-4zM0 16h4v4h-4zM36 16h4v4h-4zM4 32h4v4h-4zM8 32h4v4h-4zM12 32h4v4h-4zM16 32h4v4h-4zM20 32h4v4h-4zM24 32h4v4h-4zM28 32h4v4h-4zM32 32h4v4h-4z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M12 12h4v4h-4zM16 12h4v4h-4z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M20 12h4v4h-4zM24 12h4v4h-4zM4 16h4v4h-4zM8 16h4v4h-4zM28 16h4v4h-4zM32 16h4v4h-4zM4 20h4v4h-4zM32 20h4v4h-4zM4 24h4v4h-4zM32 24h4v4h-4zM4 28h4v4h-4zM32 28h4v4h-4z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M12 16h4v4h-4zM16 16h4v4h-4zM20 16h4v4h-4zM24 16h4v4h-4zM8 24h4v4h-4zM12 24h4v4h-4zM16 24h4v4h-4zM20 24h4v4h-4zM24 24h4v4h-4zM28 24h4v4h-4zM8 28h4v4h-4zM12 28h4v4h-4zM16 28h4v4h-4zM20 28h4v4h-4zM24 28h4v4h-4zM28 28h4v4h-4z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M0 20h4v4h-4zM36 20h4v4h-4zM0 24h4v4h-4zM36 24h4v4h-4zM0 28h4v4h-4zM36 28h4v4h-4zM0 32h4v4h-4zM36 32h4v4h-4zM4 36h4v4h-4zM8 36h4v4h-4zM12 36h4v4h-4zM16 36h4v4h-4zM20 36h4v4h-4zM24 36h4v4h-4zM28 36h4v4h-4zM32 36h4v4h-4z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M8 20h4v4h-4zM16 20h4v4h-4zM20 20h4v4h-4zM24 20h4v4h-4zM28 20h4v4h-4z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M12 20h4v4h-4z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 40,
    expression: "working",
    beat: 1,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M12 8h4v4h-4zM16 8h4v4h-4zM20 8h4v4h-4zM24 8h4v4h-4zM4 12h4v4h-4zM8 12h4v4h-4zM28 12h4v4h-4zM32 12h4v4h-4zM0 16h4v4h-4zM36 16h4v4h-4zM4 32h4v4h-4zM8 32h4v4h-4zM12 32h4v4h-4zM16 32h4v4h-4zM20 32h4v4h-4zM24 32h4v4h-4zM28 32h4v4h-4zM32 32h4v4h-4z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M12 12h4v4h-4zM16 12h4v4h-4z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M20 12h4v4h-4zM24 12h4v4h-4zM4 16h4v4h-4zM8 16h4v4h-4zM28 16h4v4h-4zM32 16h4v4h-4zM4 20h4v4h-4zM32 20h4v4h-4zM4 24h4v4h-4zM32 24h4v4h-4zM4 28h4v4h-4zM32 28h4v4h-4z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M12 16h4v4h-4zM16 16h4v4h-4zM20 16h4v4h-4zM24 16h4v4h-4zM8 24h4v4h-4zM12 24h4v4h-4zM16 24h4v4h-4zM20 24h4v4h-4zM24 24h4v4h-4zM28 24h4v4h-4zM8 28h4v4h-4zM12 28h4v4h-4zM16 28h4v4h-4zM20 28h4v4h-4zM24 28h4v4h-4zM28 28h4v4h-4z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M0 20h4v4h-4zM36 20h4v4h-4zM0 24h4v4h-4zM36 24h4v4h-4zM0 28h4v4h-4zM36 28h4v4h-4zM0 32h4v4h-4zM36 32h4v4h-4zM4 36h4v4h-4zM8 36h4v4h-4zM12 36h4v4h-4zM16 36h4v4h-4zM20 36h4v4h-4zM24 36h4v4h-4zM28 36h4v4h-4zM32 36h4v4h-4z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M8 20h4v4h-4zM12 20h4v4h-4zM20 20h4v4h-4zM24 20h4v4h-4zM28 20h4v4h-4z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M16 20h4v4h-4z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 40,
    expression: "working",
    beat: 2,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M12 8h4v4h-4zM16 8h4v4h-4zM20 8h4v4h-4zM24 8h4v4h-4zM4 12h4v4h-4zM8 12h4v4h-4zM28 12h4v4h-4zM32 12h4v4h-4zM0 16h4v4h-4zM36 16h4v4h-4zM4 32h4v4h-4zM8 32h4v4h-4zM12 32h4v4h-4zM16 32h4v4h-4zM20 32h4v4h-4zM24 32h4v4h-4zM28 32h4v4h-4zM32 32h4v4h-4z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M12 12h4v4h-4zM16 12h4v4h-4z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M20 12h4v4h-4zM24 12h4v4h-4zM4 16h4v4h-4zM8 16h4v4h-4zM28 16h4v4h-4zM32 16h4v4h-4zM4 20h4v4h-4zM32 20h4v4h-4zM4 24h4v4h-4zM32 24h4v4h-4zM4 28h4v4h-4zM32 28h4v4h-4z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M12 16h4v4h-4zM16 16h4v4h-4zM20 16h4v4h-4zM24 16h4v4h-4zM8 24h4v4h-4zM12 24h4v4h-4zM16 24h4v4h-4zM20 24h4v4h-4zM24 24h4v4h-4zM28 24h4v4h-4zM8 28h4v4h-4zM12 28h4v4h-4zM16 28h4v4h-4zM20 28h4v4h-4zM24 28h4v4h-4zM28 28h4v4h-4z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M0 20h4v4h-4zM36 20h4v4h-4zM0 24h4v4h-4zM36 24h4v4h-4zM0 28h4v4h-4zM36 28h4v4h-4zM0 32h4v4h-4zM36 32h4v4h-4zM4 36h4v4h-4zM8 36h4v4h-4zM12 36h4v4h-4zM16 36h4v4h-4zM20 36h4v4h-4zM24 36h4v4h-4zM28 36h4v4h-4zM32 36h4v4h-4z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M8 20h4v4h-4zM12 20h4v4h-4zM16 20h4v4h-4zM24 20h4v4h-4zM28 20h4v4h-4z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M20 20h4v4h-4z",
      },
    ],
  },
  {
    eyewear: "visor",
    size: 40,
    expression: "working",
    beat: 3,
    layers: [
      {
        fill: "hsl(189 32% 57%)",
        path: "M12 8h4v4h-4zM16 8h4v4h-4zM20 8h4v4h-4zM24 8h4v4h-4zM4 12h4v4h-4zM8 12h4v4h-4zM28 12h4v4h-4zM32 12h4v4h-4zM0 16h4v4h-4zM36 16h4v4h-4zM4 32h4v4h-4zM8 32h4v4h-4zM12 32h4v4h-4zM16 32h4v4h-4zM20 32h4v4h-4zM24 32h4v4h-4zM28 32h4v4h-4zM32 32h4v4h-4z",
      },
      {
        fill: "hsl(198 12% 92%)",
        path: "M12 12h4v4h-4zM16 12h4v4h-4z",
      },
      {
        fill: "hsl(192 32% 68%)",
        path: "M20 12h4v4h-4zM24 12h4v4h-4zM4 16h4v4h-4zM8 16h4v4h-4zM28 16h4v4h-4zM32 16h4v4h-4zM4 20h4v4h-4zM32 20h4v4h-4zM4 24h4v4h-4zM32 24h4v4h-4zM4 28h4v4h-4zM32 28h4v4h-4z",
      },
      {
        fill: "hsl(195 24% 80%)",
        path: "M12 16h4v4h-4zM16 16h4v4h-4zM20 16h4v4h-4zM24 16h4v4h-4zM8 24h4v4h-4zM12 24h4v4h-4zM16 24h4v4h-4zM20 24h4v4h-4zM24 24h4v4h-4zM28 24h4v4h-4zM8 28h4v4h-4zM12 28h4v4h-4zM16 28h4v4h-4zM20 28h4v4h-4zM24 28h4v4h-4zM28 28h4v4h-4z",
      },
      {
        fill: "hsl(186 32% 46%)",
        path: "M0 20h4v4h-4zM36 20h4v4h-4zM0 24h4v4h-4zM36 24h4v4h-4zM0 28h4v4h-4zM36 28h4v4h-4zM0 32h4v4h-4zM36 32h4v4h-4zM4 36h4v4h-4zM8 36h4v4h-4zM12 36h4v4h-4zM16 36h4v4h-4zM20 36h4v4h-4zM24 36h4v4h-4zM28 36h4v4h-4zM32 36h4v4h-4z",
      },
      {
        fill: "hsl(220 12% 7%)",
        path: "M8 20h4v4h-4zM12 20h4v4h-4zM16 20h4v4h-4zM20 20h4v4h-4zM28 20h4v4h-4z",
      },
      {
        fill: "hsl(192 30% 97%)",
        path: "M24 20h4v4h-4z",
      },
    ],
  },
];
