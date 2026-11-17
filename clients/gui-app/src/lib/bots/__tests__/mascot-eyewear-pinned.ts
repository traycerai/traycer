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
