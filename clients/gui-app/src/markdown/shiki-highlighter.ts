import type { HighlighterCore, ThemeRegistrationRaw } from "shiki/core";
import type { ThemePreset } from "@/lib/theme-presets";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Skip highlighting above this length: codeToHtml is sync on the main thread.
 */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** Curated grammars only - no dynamic registry. Each entry is a lazy importer; aliases live in the registration. */
const CURATED_LANG_IMPORTERS = [
  () => import("shiki/langs/typescript.mjs"),
  () => import("shiki/langs/javascript.mjs"),
  () => import("shiki/langs/tsx.mjs"),
  () => import("shiki/langs/jsx.mjs"),
  () => import("shiki/langs/python.mjs"),
  () => import("shiki/langs/json.mjs"),
  () => import("shiki/langs/html.mjs"),
  () => import("shiki/langs/css.mjs"),
  () => import("shiki/langs/bash.mjs"),
  () => import("shiki/langs/markdown.mjs"),
  () => import("shiki/langs/go.mjs"),
  () => import("shiki/langs/rust.mjs"),
  () => import("shiki/langs/java.mjs"),
  () => import("shiki/langs/c.mjs"),
  () => import("shiki/langs/cpp.mjs"),
  () => import("shiki/langs/yaml.mjs"),
  () => import("shiki/langs/toml.mjs"),
  () => import("shiki/langs/sql.mjs"),
  () => import("shiki/langs/diff.mjs"),
  () => import("shiki/langs/graphql.mjs"),
  () => import("shiki/langs/csharp.mjs"),
  () => import("shiki/langs/ruby.mjs"),
  () => import("shiki/langs/php.mjs"),
  () => import("shiki/langs/swift.mjs"),
  () => import("shiki/langs/kotlin.mjs"),
  () => import("shiki/langs/dockerfile.mjs"),
  () => import("shiki/langs/xml.mjs"),
  () => import("shiki/langs/powershell.mjs"),
  () => import("shiki/langs/ini.mjs"),
  () => import("shiki/langs/make.mjs"),
];

export type ShikiThemeId =
  | "github-dark"
  | "github-light"
  | "dracula"
  | "dracula-soft"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "nord"
  | "tokyo-night"
  | "gruvbox-dark-medium"
  | "gruvbox-light-medium"
  | "everforest-dark"
  | "everforest-light"
  | "ayu-dark"
  | "min-light";

/** Load only the active preset's light+dark pair. Switching dynamic-imports the new pair; other themes stay unfetched chunks. */
const THEME_IMPORTERS: Record<
  ShikiThemeId,
  () => Promise<{ default: ThemeRegistrationRaw }>
> = {
  "github-dark": () => import("shiki/themes/github-dark.mjs"),
  "github-light": () => import("shiki/themes/github-light.mjs"),
  dracula: () => import("shiki/themes/dracula.mjs"),
  "dracula-soft": () => import("shiki/themes/dracula-soft.mjs"),
  "catppuccin-mocha": () => import("shiki/themes/catppuccin-mocha.mjs"),
  "catppuccin-latte": () => import("shiki/themes/catppuccin-latte.mjs"),
  nord: () => import("shiki/themes/nord.mjs"),
  "tokyo-night": () => import("shiki/themes/tokyo-night.mjs"),
  "gruvbox-dark-medium": () => import("shiki/themes/gruvbox-dark-medium.mjs"),
  "gruvbox-light-medium": () => import("shiki/themes/gruvbox-light-medium.mjs"),
  "everforest-dark": () => import("shiki/themes/everforest-dark.mjs"),
  "everforest-light": () => import("shiki/themes/everforest-light.mjs"),
  "ayu-dark": () => import("shiki/themes/ayu-dark.mjs"),
  "min-light": () => import("shiki/themes/min-light.mjs"),
};

interface ShikiPresetThemes {
  light: ShikiThemeId;
  dark: ShikiThemeId;
}

const DEFAULT_SHIKI: ShikiPresetThemes = {
  light: "github-light",
  dark: "github-dark",
};

const SHIKI_BY_PRESET: Record<ThemePreset, ShikiPresetThemes> = {
  neutral: DEFAULT_SHIKI,
  "traycer-green": DEFAULT_SHIKI,
  amoled: DEFAULT_SHIKI,
  dracula: { light: "dracula-soft", dark: "dracula" },
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  github: { light: "github-light", dark: "github-dark" },
  gruvbox: { light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  "tokyo-night": { light: "min-light", dark: "tokyo-night" },
  nord: { light: "min-light", dark: "nord" },
  ayu: { light: "min-light", dark: "ayu-dark" },
  everforest: { light: "everforest-light", dark: "everforest-dark" },
  rose: DEFAULT_SHIKI,
  blue: DEFAULT_SHIKI,
  violet: DEFAULT_SHIKI,
  green: DEFAULT_SHIKI,
  orange: DEFAULT_SHIKI,
  pink: DEFAULT_SHIKI,
};

function getDocIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** Lazy createHighlighterCore singleton. Heavy runtime/grammars/themes stay behind dynamic imports; never import the full shiki index. */
export function getOrCreateHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const preset = useSettingsStore.getState().themePreset;
    const pair = SHIKI_BY_PRESET[preset];
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ])
      .then(([core, engine]) =>
        core.createHighlighterCore({
          langs: CURATED_LANG_IMPORTERS.map((importer) => importer()),
          themes: [THEME_IMPORTERS[pair.light](), THEME_IMPORTERS[pair.dark]()],
          engine: engine.createJavaScriptRegexEngine(),
        }),
      )
      .catch((err) => {
        highlighterPromise = null;
        throw err;
      });
  }
  return highlighterPromise;
}

/** One load per preset. A rejected load stays memoized so the session renders plaintext instead of retrying forever. */
const themePairLoads = new Map<ThemePreset, Promise<void>>();

function ensureThemePair(
  highlighter: HighlighterCore,
  preset: ThemePreset,
): Promise<void> {
  const pair = SHIKI_BY_PRESET[preset];
  const loaded = highlighter.getLoadedThemes();
  if (loaded.includes(pair.light) && loaded.includes(pair.dark)) {
    return Promise.resolve();
  }
  const existing = themePairLoads.get(preset);
  if (existing !== undefined) return existing;
  const load = highlighter.loadTheme(
    THEME_IMPORTERS[pair.light](),
    THEME_IMPORTERS[pair.dark](),
  );
  themePairLoads.set(preset, load);
  return load;
}

/** Active Shiki theme for the current preset + document light/dark class. */
export function resolveActiveShikiTheme(): ShikiThemeId {
  const preset = useSettingsStore.getState().themePreset;
  const pair = SHIKI_BY_PRESET[preset];
  return getDocIsDark() ? pair.dark : pair.light;
}

/** Ensure the active preset's light+dark pair is loaded on the core. */
export function ensureActiveThemePair(
  highlighter: HighlighterCore,
): Promise<void> {
  return ensureThemePair(highlighter, useSettingsStore.getState().themePreset);
}

/** Plaintext infos shiki's core handles natively without a grammar. */
const BUILTIN_ALIASES = new Set(["text", "txt", "plain", "plaintext"]);

/** null while the theme pair is loading (transient) or when the language is outside the curated set (permanent plaintext fallback). */
export function highlightCode(
  highlighter: HighlighterCore,
  code: string,
  lang: string,
  theme: string,
): string | null {
  if (!highlighter.getLoadedThemes().includes(theme)) return null;
  if (
    !BUILTIN_ALIASES.has(lang) &&
    !highlighter.getLoadedLanguages().includes(lang)
  ) {
    return null;
  }
  try {
    return highlighter.codeToHtml(code, { lang, theme });
  } catch {
    return null;
  }
}
