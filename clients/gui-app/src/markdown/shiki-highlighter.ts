import { useEffect, useState, useSyncExternalStore } from "react";
import type { HighlighterCore, ThemeRegistrationRaw } from "shiki/core";
import type { ThemePreset } from "@/lib/theme-presets";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * Content longer than this (in characters) skips syntax highlighting -
 * Shiki's `codeToHtml` is synchronous and runs on the main thread; above
 * this size it would freeze the UI for seconds. Callers fall back to a
 * plain `<pre>` instead.
 */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * The curated grammar set. This is the ceiling: anything outside it renders
 * as plaintext - there is deliberately NO dynamic registry fallback, which is
 * what lets the build drop shiki's full ~200-grammar bundle wiring. Each
 * entry is an explicit lazy importer so Vite emits one analyzable chunk per
 * grammar, all loaded together behind the highlighter's lazy boundary.
 * Aliases ship inside each registration (`ts`, `js`, `py`, `sh`, `golang`,
 * `c#`, `docker`, `makefile`, ...), so common fence infos resolve for free.
 * `make` is included because `languageForFileName` emits it for Makefiles.
 */
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

/**
 * Only the ACTIVE preset's light+dark pair is loaded (at highlighter
 * creation); switching presets dynamic-imports the new pair on demand via
 * `ensureThemePair`. The other ~12 themes stay as unfetched async chunks.
 */
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

function subscribeDocClass(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => {
    observer.disconnect();
  };
}

function getDocIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

function getServerIsDark(): boolean {
  return true;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Lazy singleton over `createHighlighterCore`. Everything heavy - the core
 * runtime, the JS regex engine, the 30 curated grammars, and the active
 * preset's theme pair - stays behind dynamic imports, so none of it lands in
 * the entry bundle and the full-registry `shiki` index is never referenced.
 */
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

/**
 * One in-flight/settled load per preset. A rejected load stays memoized
 * (mirrors the old `failedThemes` negative cache): the preset renders plain
 * code for the session instead of retrying forever.
 */
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

/**
 * Self-contained Shiki theme + highlighter hook.
 *
 * Reads the active preset from `useSettingsStore` and the resolved
 * light/dark from the `<html>` `.dark` class via `useSyncExternalStore`
 * (the global `ThemeProvider` toggles that class). Maps both to a
 * `ShikiThemeId` via `SHIKI_BY_PRESET`.
 *
 * `themesVersion` bumps when a lazily-loaded theme pair lands; consumers must
 * include it in their highlight memo deps so code re-highlights once the
 * newly-selected preset's themes are available (only the active pair is
 * loaded eagerly).
 */
export function useShikiHighlighter(): {
  highlighter: HighlighterCore | null;
  theme: ShikiThemeId;
  themesVersion: number;
} {
  const preset = useSettingsStore((s) => s.themePreset);
  const isDark = useSyncExternalStore(
    subscribeDocClass,
    getDocIsDark,
    getServerIsDark,
  );
  const shikiPair = SHIKI_BY_PRESET[preset];
  const theme = isDark ? shikiPair.dark : shikiPair.light;

  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null);
  const [themesVersion, setThemesVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getOrCreateHighlighter()
      .then((h) => {
        if (!cancelled) setHighlighter(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (highlighter === null) return;
    if (highlighter.getLoadedThemes().includes(theme)) return;
    let cancelled = false;
    ensureThemePair(highlighter, preset)
      .then(() => {
        if (!cancelled) setThemesVersion((version) => version + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [highlighter, preset, theme]);

  return { highlighter, theme, themesVersion };
}

/** Plaintext infos shiki's core handles natively without a grammar. */
const BUILTIN_ALIASES = new Set(["text", "txt", "plain", "plaintext"]);

/**
 * Synchronous highlight against the curated core highlighter. Returns `null`
 * when the requested theme pair hasn't finished loading (transient - the
 * hook's `themesVersion` bump re-renders consumers when it lands) or when the
 * language is outside the curated set (permanent - the caller's plain `<pre>`
 * fallback is the final rendering).
 */
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
