import { makeLiteralGuard } from "@/lib/type-guard";

export type GitDiffViewMode = "split" | "unified";

// Maps to @pierre/diffs `diffIndicators`: per-line change marks in the gutter.
// "bars" = colored bars (Pierre default), "classic" = +/- marks, "none" = hidden.
export type GitDiffIndicatorStyle = "bars" | "classic" | "none";

/**
 * Shared, user-level diff viewer configuration. Owned by `useSettingsStore`
 * and consumed by every git and snapshot diff renderer, so changing one field
 * live-updates all mounted viewers. Tile-local state (e.g. which files are
 * collapsed in a concrete diff) is intentionally NOT part of this shape.
 */
export interface DiffViewerPreferences {
  readonly mode: GitDiffViewMode;
  readonly wordWrap: boolean;
  readonly ignoreWhitespace: boolean;
  // Positive UI flags; inverted to Pierre's disable* options at render time.
  readonly backgrounds: boolean;
  readonly lineNumbers: boolean;
  readonly indicatorStyle: GitDiffIndicatorStyle;
}

export interface DiffViewerPreferencesPatch {
  readonly mode?: GitDiffViewMode;
  readonly wordWrap?: boolean;
  readonly ignoreWhitespace?: boolean;
  readonly backgrounds?: boolean;
  readonly lineNumbers?: boolean;
  readonly indicatorStyle?: GitDiffIndicatorStyle;
}

/**
 * Defaults mirror @pierre/diffs (split view, backgrounds + line numbers on,
 * "bars" gutter) and match today's hardcoded diff tile defaults so existing
 * tiles render identically once preferences are threaded through.
 */
export const DEFAULT_DIFF_VIEWER_PREFERENCES: DiffViewerPreferences = {
  mode: "split",
  wordWrap: false,
  ignoreWhitespace: false,
  backgrounds: true,
  lineNumbers: true,
  indicatorStyle: "bars",
};

const isGitDiffViewMode = makeLiteralGuard<GitDiffViewMode>({
  split: true,
  unified: true,
});

const isGitDiffIndicatorStyle = makeLiteralGuard<GitDiffIndicatorStyle>({
  bars: true,
  classic: true,
  none: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function persistedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Defensively reconstructs diff viewer preferences from persisted/untrusted
 * data. Each field falls back independently to the supplied `fallback` value,
 * so a single corrupt field never discards the rest.
 */
export function normalizeDiffViewerPreferences(
  value: unknown,
  fallback: DiffViewerPreferences,
): DiffViewerPreferences {
  if (!isRecord(value)) return fallback;
  return {
    mode:
      typeof value.mode === "string" && isGitDiffViewMode(value.mode)
        ? value.mode
        : fallback.mode,
    wordWrap: persistedBoolean(value.wordWrap, fallback.wordWrap),
    ignoreWhitespace: persistedBoolean(
      value.ignoreWhitespace,
      fallback.ignoreWhitespace,
    ),
    backgrounds: persistedBoolean(value.backgrounds, fallback.backgrounds),
    lineNumbers: persistedBoolean(value.lineNumbers, fallback.lineNumbers),
    indicatorStyle:
      typeof value.indicatorStyle === "string" &&
      isGitDiffIndicatorStyle(value.indicatorStyle)
        ? value.indicatorStyle
        : fallback.indicatorStyle,
  };
}
