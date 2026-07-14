/**
 * WCAG contrast-ratio calculator for `oklch(...)`/hex color strings, plus a
 * snapshot of `src/index.css`'s per-preset surface tokens. Lets tests assert
 * real contrast ratios against resolved theme colors instead of only
 * checking for a Tailwind class name.
 *
 * The surface tables below mirror `src/index.css` and must be kept in sync
 * with it by hand - accent-only presets (rose/blue/violet/green/orange/pink)
 * are omitted because they inherit the default `:root`/`.dark`
 * background/canvas/popover unchanged.
 */

export interface ThemeSurfaces {
  readonly background: string;
  readonly canvas: string;
  readonly popover: string;
}

export const LIGHT_THEME_SURFACES: Readonly<Record<string, ThemeSurfaces>> = {
  default: {
    background: "oklch(0.985 0 0)",
    canvas: "oklch(1 0 0)",
    popover: "oklch(1 0 0)",
  },
  amoled: { background: "#fafafa", canvas: "#ffffff", popover: "#ffffff" },
  "traycer-green": {
    background: "#f6f9f8",
    canvas: "#ffffff",
    popover: "#ffffff",
  },
  dracula: { background: "#efefef", canvas: "#f8f8f2", popover: "#ffffff" },
  catppuccin: {
    background: "#e6e9ef",
    canvas: "#eff1f5",
    popover: "#e6e9ef",
  },
  github: { background: "#f6f8fa", canvas: "#ffffff", popover: "#ffffff" },
  gruvbox: { background: "#f2e5bc", canvas: "#fbf1c7", popover: "#f2e5bc" },
  "tokyo-night": {
    background: "#d0d5e3",
    canvas: "#e1e2e7",
    popover: "#d0d5e3",
  },
  nord: { background: "#e5e9f0", canvas: "#eceff4", popover: "#e5e9f0" },
  ayu: { background: "#f8f9fa", canvas: "#fcfcfc", popover: "#f8f9fa" },
  everforest: {
    background: "#f4f0d9",
    canvas: "#fdf6e3",
    popover: "#f4f0d9",
  },
};

export const DARK_THEME_SURFACES: Readonly<Record<string, ThemeSurfaces>> = {
  default: {
    background: "oklch(0.205 0 0)",
    canvas: "oklch(0.145 0 0)",
    popover: "oklch(0.205 0 0)",
  },
  amoled: { background: "#000000", canvas: "#000000", popover: "#1a1a1a" },
  "traycer-green": {
    background: "#121715",
    canvas: "#0f0f0f",
    popover: "#1a2421",
  },
  dracula: { background: "#21222c", canvas: "#282a36", popover: "#343746" },
  catppuccin: {
    background: "#181825",
    canvas: "#1e1e2e",
    popover: "#313244",
  },
  github: { background: "#010409", canvas: "#0d1117", popover: "#161b22" },
  gruvbox: { background: "#1d2021", canvas: "#282828", popover: "#32302f" },
  "tokyo-night": {
    background: "#16161e",
    canvas: "#1a1b26",
    popover: "#24283b",
  },
  nord: { background: "#242933", canvas: "#2e3440", popover: "#3b4252" },
  ayu: { background: "#080b10", canvas: "#0b0e14", popover: "#11151c" },
  everforest: {
    background: "#232a2e",
    canvas: "#2d353b",
    popover: "#343f44",
  },
};

// `--muted-foreground` per preset - unlike the surfaces above, presets
// override this alongside their own hue, so light/dark tables must carry
// the actual per-preset value (not the default gray).
export const MUTED_FOREGROUND_LIGHT: Readonly<Record<string, string>> = {
  default: "oklch(0.556 0 0)",
  amoled: "#7d7d7d",
  "traycer-green": "#666666",
  dracula: "#4f5d86",
  catppuccin: "#5c6074",
  github: "#656d76",
  gruvbox: "#665c54",
  "tokyo-night": "#3f528f",
  nord: "#4c566a",
  ayu: "#626a73",
  everforest: "#5f6b62",
};

export const MUTED_FOREGROUND_DARK: Readonly<Record<string, string>> = {
  default: "oklch(0.708 0 0)",
  amoled: "#a0a0a0",
  "traycer-green": "#a8a8a8",
  dracula: "#a1a8c3",
  catppuccin: "#a6adc8",
  github: "#8b949e",
  gruvbox: "#a89984",
  "tokyo-night": "#9aa5ce",
  nord: "#d8dee9",
  ayu: "#828890",
  everforest: "#a4afa7",
};

// `--destructive` and `--success-foreground` are intentionally NOT
// preset-overridden (see index.css) - one value each for light/dark.
export const DESTRUCTIVE_FOREGROUND = {
  light: "oklch(0.577 0.245 27.325)",
  dark: "oklch(0.704 0.191 22.216)",
} as const;

export const SUCCESS_FOREGROUND = {
  light: "oklch(0.42 0.13 145)",
  dark: "oklch(0.75 0.15 145)",
} as const;

function linearChannel(normalized: number): number {
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function hexToLinearSrgb(hex: string): readonly [number, number, number] {
  const normalized = hex.replace("#", "");
  const byteAt = (start: number): number =>
    parseInt(normalized.slice(start, start + 2), 16) / 255;
  return [
    linearChannel(byteAt(0)),
    linearChannel(byteAt(2)),
    linearChannel(byteAt(4)),
  ];
}

// OKLab -> linear sRGB, per the CSS Color 4 / Björn Ottosson reference
// matrices used by browsers to resolve `oklch(...)`.
function oklchToLinearSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): readonly [number, number, number] {
  const hueRadians = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function parseColorToLinearSrgb(
  value: string,
): readonly [number, number, number] {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return hexToLinearSrgb(trimmed);
  const match = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(trimmed);
  if (match === null) {
    throw new Error(`Unsupported color for contrast calculation: ${value}`);
  }
  return oklchToLinearSrgb(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
}

function relativeLuminance(
  linearSrgb: readonly [number, number, number],
): number {
  const clamp = (channel: number): number => Math.min(1, Math.max(0, channel));
  const [r, g, b] = linearSrgb;
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/** WCAG 2.x contrast ratio (1:1 to 21:1) between two `oklch(...)`/hex colors. */
export function contrastRatio(foreground: string, background: string): number {
  const fgLuminance = relativeLuminance(parseColorToLinearSrgb(foreground));
  const bgLuminance = relativeLuminance(parseColorToLinearSrgb(background));
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Alpha-composites `foreground` at `alpha` over `background` in sRGB gamma
 * space (matching how browsers paint a translucent CSS background color),
 * returning a hex string usable with `contrastRatio`.
 */
export function compositeOverBackground(
  foreground: string,
  alpha: number,
  background: string,
): string {
  const toSrgbByte = (linear: number): number => {
    const clamped = Math.min(1, Math.max(0, linear));
    const encoded =
      clamped <= 0.0031308
        ? clamped * 12.92
        : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  };
  const mixChannel = (fgLinear: number, bgLinear: number): string => {
    const fgByte = toSrgbByte(fgLinear);
    const bgByte = toSrgbByte(bgLinear);
    const mixedByte = Math.round(fgByte * alpha + bgByte * (1 - alpha));
    return mixedByte.toString(16).padStart(2, "0");
  };
  const [fgR, fgG, fgB] = parseColorToLinearSrgb(foreground);
  const [bgR, bgG, bgB] = parseColorToLinearSrgb(background);
  return `#${mixChannel(fgR, bgR)}${mixChannel(fgG, bgG)}${mixChannel(fgB, bgB)}`;
}
