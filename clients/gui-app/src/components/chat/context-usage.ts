import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

/**
 * "Tokens occupying the window" / "window size" pair plus the derived "% left",
 * all computed from one place so the chip headline and its tooltip breakdown
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
