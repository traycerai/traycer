import type {
  HighlighterCore,
  LanguageRegistration,
  ThemeRegistrationRaw,
} from "shiki/core";
import type { ThemePreset } from "@/lib/theme-presets";
import { getActiveThemePreset } from "@/lib/theme-applier";
import { getActiveSyntaxTheme } from "@/lib/themes/syntax-theme";

/**
 * Content longer than this (in characters) skips syntax highlighting -
 * Shiki's `codeToHtml` is synchronous and runs on the main thread; above
 * this size it would freeze the UI for seconds. Callers fall back to a
 * plain `<pre>` instead.
 */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * One curated grammar: its chunk, and every fence info that routes to it.
 *
 * `infos` has to be spelled out because the per-grammar lookup now happens
 * BEFORE the chunk is fetched. It is shiki's own `name` for the grammar (not
 * always the import id - `bash` registers `shellscript`, `dockerfile`
 * registers `docker`) followed by the aliases that grammar declares (`ts`,
 * `py`, `sh`, `c#`, `yml`, `makefile`, ...), which used to resolve for free
 * from the registration itself. Loading a grammar still registers its own
 * aliases, so `getLoadedLanguages` and `codeToHtml` keep taking them.
 */
interface CuratedGrammar {
  /** Shiki's import id, and the dedupe key for this grammar's one load. */
  readonly id: string;
  /** Every fence info that resolves to this grammar. */
  readonly infos: readonly string[];
  readonly load: () => Promise<{ default: LanguageRegistration[] }>;
}

/**
 * The curated grammar set. This is the ceiling: anything outside it renders
 * as plaintext - there is deliberately NO dynamic registry fallback, which is
 * what lets the build drop shiki's full ~200-grammar bundle wiring. Each
 * entry is an explicit lazy importer so Vite emits one analyzable chunk per
 * grammar, and `ensureLanguage` fetches ONLY the chunk a rendered fence asks
 * for. The set used to be loaded whole behind the highlighter's lazy boundary,
 * so the first code block anywhere pulled all 30 grammars (45 chunks, ~2.4 MB
 * of evaluated JS) and kept every one of them alive for the session - a phone
 * showing one epic of TypeScript now parses one grammar.
 *
 * What is NOT here is no longer reachable by accident: loading all 30 also
 * registered the grammars they embed (`glsl`, `haml`, `lua`, `regexp`), so a
 * `lua` fence used to highlight as a side effect of ruby being loaded. Those
 * were never part of the curated set and now render plain, which is what the
 * set says. `make` IS here because `languageForFileName` emits it for
 * Makefiles.
 */
const CURATED_GRAMMARS: readonly CuratedGrammar[] = [
  {
    id: "typescript",
    infos: ["typescript", "ts", "cts", "mts"],
    load: () => import("shiki/langs/typescript.mjs"),
  },
  {
    id: "javascript",
    infos: ["javascript", "js", "cjs", "mjs"],
    load: () => import("shiki/langs/javascript.mjs"),
  },
  { id: "tsx", infos: ["tsx"], load: () => import("shiki/langs/tsx.mjs") },
  { id: "jsx", infos: ["jsx"], load: () => import("shiki/langs/jsx.mjs") },
  {
    id: "python",
    infos: ["python", "py"],
    load: () => import("shiki/langs/python.mjs"),
  },
  { id: "json", infos: ["json"], load: () => import("shiki/langs/json.mjs") },
  { id: "html", infos: ["html"], load: () => import("shiki/langs/html.mjs") },
  { id: "css", infos: ["css"], load: () => import("shiki/langs/css.mjs") },
  {
    id: "bash",
    infos: ["shellscript", "bash", "sh", "shell", "zsh"],
    load: () => import("shiki/langs/bash.mjs"),
  },
  {
    id: "markdown",
    infos: ["markdown", "md"],
    load: () => import("shiki/langs/markdown.mjs"),
  },
  { id: "go", infos: ["go"], load: () => import("shiki/langs/go.mjs") },
  {
    id: "rust",
    infos: ["rust", "rs"],
    load: () => import("shiki/langs/rust.mjs"),
  },
  { id: "java", infos: ["java"], load: () => import("shiki/langs/java.mjs") },
  { id: "c", infos: ["c"], load: () => import("shiki/langs/c.mjs") },
  {
    id: "cpp",
    infos: ["cpp", "c++"],
    load: () => import("shiki/langs/cpp.mjs"),
  },
  {
    id: "yaml",
    infos: ["yaml", "yml"],
    load: () => import("shiki/langs/yaml.mjs"),
  },
  { id: "toml", infos: ["toml"], load: () => import("shiki/langs/toml.mjs") },
  { id: "sql", infos: ["sql"], load: () => import("shiki/langs/sql.mjs") },
  { id: "diff", infos: ["diff"], load: () => import("shiki/langs/diff.mjs") },
  {
    id: "graphql",
    infos: ["graphql", "gql"],
    load: () => import("shiki/langs/graphql.mjs"),
  },
  {
    id: "csharp",
    infos: ["csharp", "c#", "cs"],
    load: () => import("shiki/langs/csharp.mjs"),
  },
  {
    id: "ruby",
    infos: ["ruby", "rb"],
    load: () => import("shiki/langs/ruby.mjs"),
  },
  { id: "php", infos: ["php"], load: () => import("shiki/langs/php.mjs") },
  {
    id: "swift",
    infos: ["swift"],
    load: () => import("shiki/langs/swift.mjs"),
  },
  {
    id: "kotlin",
    infos: ["kotlin", "kt", "kts"],
    load: () => import("shiki/langs/kotlin.mjs"),
  },
  {
    id: "dockerfile",
    infos: ["docker", "dockerfile"],
    load: () => import("shiki/langs/dockerfile.mjs"),
  },
  { id: "xml", infos: ["xml"], load: () => import("shiki/langs/xml.mjs") },
  {
    id: "powershell",
    infos: ["powershell", "ps", "ps1", "pwsh"],
    load: () => import("shiki/langs/powershell.mjs"),
  },
  {
    id: "ini",
    infos: ["ini", "properties"],
    load: () => import("shiki/langs/ini.mjs"),
  },
  {
    id: "make",
    infos: ["make", "makefile"],
    load: () => import("shiki/langs/make.mjs"),
  },
];

/**
 * Fence info -> its grammar, built once at module load. Matching is exact,
 * like the `getLoadedLanguages()` check it replaces: a `TS` fence resolved to
 * nothing before this change and still does, rather than fetching a chunk the
 * highlight would then decline to use.
 */
const GRAMMAR_BY_INFO = new Map<string, CuratedGrammar>(
  CURATED_GRAMMARS.flatMap((grammar) =>
    grammar.infos.map((info): [string, CuratedGrammar] => [info, grammar]),
  ),
);

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

function getDocIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Lazy singleton over `createHighlighterCore`. Everything heavy - the core
 * runtime, the JS regex engine, the active preset's theme pair - stays behind
 * dynamic imports, so none of it lands in the entry bundle and the
 * full-registry `shiki` index is never referenced. The core boots with NO
 * grammars: each one arrives through `ensureLanguage` when a fence asks for
 * it, so the cost of the first code block is the core plus one grammar rather
 * than the core plus all thirty.
 */
export function getOrCreateHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const preset = getActiveThemePreset();
    const pair = SHIKI_BY_PRESET[preset];
    const custom = getActiveSyntaxTheme();
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ])
      .then(([core, engine]) =>
        core.createHighlighterCore({
          langs: [],
          themes:
            custom === null
              ? [THEME_IMPORTERS[pair.light](), THEME_IMPORTERS[pair.dark]()]
              : [custom],
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

/** Active Shiki theme for the current preset + document light/dark class. */
export function resolveActiveShikiTheme(): string {
  const custom = getActiveSyntaxTheme();
  if (custom?.name !== undefined) return custom.name;
  const preset = getActiveThemePreset();
  const pair = SHIKI_BY_PRESET[preset];
  return getDocIsDark() ? pair.dark : pair.light;
}

/** Ensure the active preset's light+dark pair is loaded on the core. */
export function ensureActiveThemePair(
  highlighter: HighlighterCore,
): Promise<void> {
  const custom = getActiveSyntaxTheme();
  if (custom?.name !== undefined) {
    return highlighter.getLoadedThemes().includes(custom.name)
      ? Promise.resolve()
      : highlighter.loadTheme(custom);
  }
  return ensureThemePair(highlighter, getActiveThemePreset());
}

/** Plaintext infos shiki's core handles natively without a grammar. */
const BUILTIN_ALIASES = new Set(["text", "txt", "plain", "plaintext"]);

/**
 * Whether a fence info can be highlighted right now.
 *
 * `"loading"` is the only transient answer: the caller renders plain and
 * re-renders when `load` settles. `"unsupported"` is final - the info is
 * outside the curated set, so there is nothing to fetch and the plain `<pre>`
 * is the last word.
 */
export type LanguageReadiness =
  | { readonly state: "ready" }
  | { readonly state: "loading"; readonly load: Promise<void> }
  | { readonly state: "unsupported" };

const READY: LanguageReadiness = Object.freeze({ state: "ready" as const });
const UNSUPPORTED: LanguageReadiness = Object.freeze({
  state: "unsupported" as const,
});

/**
 * One in-flight/settled load per grammar, keyed by {@link CuratedGrammar.id}
 * so `ts` and `typescript` asking at the same time share a single fetch -
 * which they do, constantly, because every visible code block re-asks on
 * every streamed frame.
 *
 * A FAILED load stays memoized, like `themePairLoads`: the load resolves
 * either way and `highlightCode`'s loaded-language check is what decides, so
 * a dead chunk renders plain for the session instead of being re-fetched on
 * every re-render.
 */
const grammarLoads = new Map<string, Promise<void>>();

/**
 * Ensures the grammar for `lang` is on the core, fetching its chunk the first
 * time it is asked for. Cheap to call repeatedly once loaded.
 */
export function ensureLanguage(
  highlighter: HighlighterCore,
  lang: string,
): LanguageReadiness {
  if (BUILTIN_ALIASES.has(lang)) return READY;
  const grammar = GRAMMAR_BY_INFO.get(lang);
  if (grammar === undefined) return UNSUPPORTED;
  // Grammars embed their dependencies (html carries javascript and css), so
  // an info can already be registered by a chunk nobody asked for by name.
  if (highlighter.getLoadedLanguages().includes(lang)) return READY;
  const existing = grammarLoads.get(grammar.id);
  if (existing !== undefined) return { state: "loading", load: existing };
  const load = highlighter
    .loadLanguage(grammar.load())
    .then(() => undefined)
    .catch(() => undefined);
  grammarLoads.set(grammar.id, load);
  return { state: "loading", load };
}

/**
 * Test seam: drops the singleton core and every memoized theme / grammar
 * load, so a suite can assert what a FRESH core fetches.
 */
export function resetShikiHighlighterForTests(): void {
  highlighterPromise = null;
  themePairLoads.clear();
  grammarLoads.clear();
}

/**
 * Synchronous highlight against the curated core highlighter. Returns `null`
 * when the requested theme pair hasn't finished loading (transient - the
 * hook's `themesVersion` bump re-renders consumers when it lands), when the
 * requested grammar hasn't been loaded yet (transient too, and the caller
 * answers it by calling `ensureLanguage`), or when the language is outside the
 * curated set (permanent - the caller's plain `<pre>` fallback is the final
 * rendering). It never fetches anything itself: it is called from render.
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
