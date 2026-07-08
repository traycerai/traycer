import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

/**
 * "Tokens occupying the window" / "window size" pair plus the derived "% left",
 * all computed from one place so the chip headline and detail breakdowns
 * can't drift. Each harness adapter owns its SDK's cache semantics and emits
 * `contextTokens` as the canonical dynamic occupancy number. Harnesses that
 * report a fixed baseline separately can set `contextBaselineTokens`; the
 * renderer folds that into used tokens while keeping the model's reported
 * context window as the denominator.
 * Returns `null` when no reliable percent can be derived.
 */
export interface EffectiveContextUsage {
  /** Tokens occupying the window, including any fixed baseline. */
  readonly used: number;
  /** Reported model context window size. */
  readonly window: number;
  /** Whole-percent of the effective window still free, 0..100. */
  readonly percentLeft: number;
}

export function computeEffectiveContextUsage(
  usage: TokenUsage | null,
): EffectiveContextUsage | null {
  if (usage === null) return null;
  const contextWindow = usage.contextWindow;
  if (contextWindow === undefined || contextWindow <= 0) return null;
  const rawUsed = usage.contextTokens ?? usage.inputTokens;
  const baseline = Math.max(0, usage.contextBaselineTokens ?? 0);
  const window = contextWindow;
  // Cap at the window: occupancy + a fixed baseline can exceed the reported
  // window near the limit, and the tooltip renders `used / window` verbatim, so
  // an uncapped value shows a nonsensical "277K / 272K". Clamping reads as
  // "100% used" and keeps percentLeft at 0.
  const used = Math.min(window, Math.max(0, rawUsed) + baseline);
  if (used <= 0) return null;
  // `window > 0` is guaranteed above, so the ratio is always finite.
  const clamped = Math.max(0, Math.min(1, 1 - used / window));
  return { used, window, percentLeft: Math.round(clamped * 100) };
}

/**
 * One breakdown row shared by every context usage detail surface. A
 * `total` makes the row render as `value / total` against the context window;
 * `null` renders the value on its own. Keeping the row model here is the single
 * source of truth for which rows appear and how cache-derived numbers are
 * computed, so the surfaces can't drift in their displayed math.
 */
export interface ContextUsageRow {
  readonly key: "used" | "fresh" | "cacheRead" | "cacheWrite" | "output";
  readonly label: string;
  readonly value: number;
  /** Context-window denominator when the row is a `used / window` pair. */
  readonly total: number | null;
}

/**
 * Build the ordered breakdown rows for a usage/effective pair. Cache rows are
 * omitted when their values are absent so the surfaces never show noisy zeros,
 * and "Fresh" is hidden without any cache because "Used" already tells the
 * whole story then.
 */
export function buildContextUsageRows(
  usage: TokenUsage,
  effective: EffectiveContextUsage,
): readonly ContextUsageRow[] {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreate = usage.cacheCreationInputTokens ?? 0;
  // `effective.used` already folds in any fixed baseline tokens; the baseline is
  // not repeated as its own row.
  const used = effective.used;
  // "Fresh" = portion of `used` that wasn't served from cache.
  const fresh = Math.max(0, used - cacheRead - cacheCreate);
  const hasCache = cacheRead > 0 || cacheCreate > 0;
  const rows: ContextUsageRow[] = [
    { key: "used", label: "Used", value: used, total: effective.window },
  ];
  if (hasCache) {
    rows.push({ key: "fresh", label: "Fresh", value: fresh, total: null });
  }
  if (cacheRead > 0) {
    rows.push({
      key: "cacheRead",
      label: "Cache read",
      value: cacheRead,
      total: null,
    });
  }
  if (cacheCreate > 0) {
    rows.push({
      key: "cacheWrite",
      label: "Cache write",
      value: cacheCreate,
      total: null,
    });
  }
  rows.push({
    key: "output",
    label: "Output",
    value: usage.outputTokens,
    total: null,
  });
  return rows;
}

/** Render a row's value, as `value / total` when the row carries a denominator. */
export function formatContextUsageRowValue(row: ContextUsageRow): string {
  if (row.total === null) return formatTokens(row.value);
  return `${formatContextWindowTokens(row.value)} / ${formatContextWindowTokens(row.total)}`;
}

/**
 * Compact token formatter for standalone counts: 1_234 → "1.2k",
 * 1_234_567 → "1.2M". Falls back to raw `toLocaleString` for values < 1k so
 * tiny output-only turns aren't misleadingly rounded.
 */
function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Whole-unit token formatter for the `used / window` context-window pair. */
export function formatContextWindowTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000).toLocaleString()}K`;
  }
  return `${Math.round(value / 1_000_000).toLocaleString()}M`;
}

/**
 * Shared "how much headroom is left" tone scale: `percent` is a LEFT/
 * remaining percentage (0 = exhausted), not a used percentage - low
 * remaining reads as destructive/amber. Reused by the context-window chip
 * and the provider rate-limit views, which invert their native
 * `usedPercent` (`100 - usedPercent`) before calling this so both surfaces
 * share one polarity and one set of thresholds.
 */
export function contextUsageTone(percent: number): string {
  if (percent <= 10) return "text-destructive";
  if (percent <= 25) return "text-amber-500 dark:text-amber-400";
  return "text-muted-foreground";
}
