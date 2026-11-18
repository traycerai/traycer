export type ThemePreset =
  | "neutral"
  | "traycer-green"
  | "amoled"
  | "dracula"
  | "catppuccin"
  | "github"
  | "gruvbox"
  | "tokyo-night"
  | "nord"
  | "ayu"
  | "everforest"
  | "rose"
  | "blue"
  | "violet"
  | "green"
  | "orange"
  | "pink";

export interface ThemePresetOption {
  id: ThemePreset;
  label: string;
  swatch: string;
  fg: string;
  accent: string;
}

export const THEME_PRESETS: ReadonlyArray<ThemePresetOption> = [
  {
    id: "neutral",
    label: "Neutral",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.205 0 0)",
  },
  {
    id: "traycer-green",
    label: "Traycer Green",
    swatch: "#1A2421",
    fg: "#FFFFFF",
    accent: "#257174",
  },
  {
    id: "amoled",
    label: "Amoled",
    swatch: "#000000",
    fg: "#ededed",
    accent: "#006bff",
  },
  {
    id: "dracula",
    label: "Dracula",
    swatch: "#282a36",
    fg: "#f8f8f2",
    accent: "#bd93f9",
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    swatch: "#1e1e2e",
    fg: "#cdd6f4",
    accent: "#cba6f7",
  },
  {
    id: "github",
    label: "GitHub",
    swatch: "#0d1117",
    fg: "#c9d1d9",
    accent: "#58a6ff",
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    swatch: "#282828",
    fg: "#ebdbb2",
    accent: "#fabd2f",
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    swatch: "#1a1b26",
    fg: "#c0caf5",
    accent: "#7aa2f7",
  },
  {
    id: "nord",
    label: "Nord",
    swatch: "#2e3440",
    fg: "#eceff4",
    accent: "#88c0d0",
  },
  {
    id: "ayu",
    label: "Ayu",
    swatch: "#0b0e14",
    fg: "#bfbdb6",
    accent: "#e6b450",
  },
  {
    id: "everforest",
    label: "Everforest",
    swatch: "#2d353b",
    fg: "#d3c6aa",
    accent: "#a7c080",
  },
  {
    id: "rose",
    label: "Rose",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.645 0.246 16.439)",
  },
  {
    id: "blue",
    label: "Blue",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.546 0.245 262.881)",
  },
  {
    id: "violet",
    label: "Violet",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.606 0.25 292.717)",
  },
  {
    id: "green",
    label: "Green",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.648 0.15 160.19)",
  },
  {
    id: "orange",
    label: "Orange",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.705 0.213 47.604)",
  },
  {
    id: "pink",
    label: "Pink",
    swatch: "oklch(0.205 0 0)",
    fg: "oklch(0.985 0 0)",
    accent: "oklch(0.656 0.241 354.308)",
  },
];

export const DEFAULT_THEME_PRESET: ThemePreset = "traycer-green";

const PRESET_BY_ID: ReadonlyMap<ThemePreset, ThemePresetOption> = new Map(
  THEME_PRESETS.map((preset) => [preset.id, preset]),
);

export function findThemePreset(id: ThemePreset): ThemePresetOption {
  return PRESET_BY_ID.get(id) ?? THEME_PRESETS[0];
}
