import type { PercentMode } from "@/stores/settings/layout-store";

/**
 * One rate-limit reading as the status bar words it: `57% used`, or
 * `43% remaining`.
 *
 * Its own module because two surfaces say it about the same numbers — the
 * window text a sighted user reads, and the accessible name of the trigger
 * those windows sit inside — and two spellings of one reading is how a screen
 * reader and a screen end up disagreeing.
 *
 * Remaining is the complement of the ROUNDED used percentage, not the rounding
 * of the complement: computed the other way, 33.4% used reads as 33% used and
 * 67% remaining, and the two numbers in one bar fail to add up.
 */
export function windowPercentText(
  usedPercent: number,
  percentMode: PercentMode,
): string {
  return `${windowPercentValueText(usedPercent, percentMode)} ${percentMode}`;
}

/**
 * The number alone - `57%` - for the levels of the status bar's collapse ladder
 * that have dropped the word after it.
 *
 * Split out rather than sliced off the sentence above, because the number is
 * also the part that carries the severity color: the two are one span and the
 * mode word is another, so a reader still sees one string while only the
 * percentage is tinted.
 */
export function windowPercentValueText(
  usedPercent: number,
  percentMode: PercentMode,
): string {
  const used = Math.round(usedPercent);
  return `${percentMode === "used" ? used : 100 - used}%`;
}

/**
 * What follows the percentage in one strip reading — `4h 15m`, `Fable 6d 4h`,
 * `wk`, or nothing at all.
 *
 * **A name earns its place by DISAMBIGUATING, and only then.** A provider
 * showing ONE reading has nothing to tell it apart from, so its name says
 * nothing the icon beside it has not already said, on the scarcest row in the
 * app: the countdown alone is the whole reading. The name comes straight back
 * when there is no countdown to print — no `resetsAt`, or the timer switched
 * off — because a bare percentage under an icon names no limit at all.
 *
 * With TWO OR MORE visible limits every reading has a sibling to be confused
 * with, and the two kinds of name part ways. A DURATION name (`5h`, `wk`) is
 * replaced by the countdown, which states the same fact more precisely. Every
 * other name — a model, a Cursor bucket, a named Codex limit — is the only
 * thing identifying WHICH limit the percentage belongs to, and several of them
 * are guaranteed to share one reset instant with a sibling, so dropping it
 * would print two windows as one indistinguishable string.
 *
 * `visibleWindowCount` is the provider's visible windows, NOT the ones this
 * rung happens to draw: an unexpanded provider draws its tightest alone and
 * still has to say which of several that one is. It is passed in rather than
 * re-derived here, so the count that decided what to draw is the count that
 * words it.
 *
 * Settings' chip row is deliberately not a caller. It lists every limit a
 * provider has so they can be toggled individually, so there a name is the
 * whole point even when there is only one.
 */
export function windowLabelText(params: {
  readonly label: string;
  readonly labelIsDuration: boolean;
  readonly countdown: string | null;
  readonly visibleWindowCount: number;
}): string {
  if (params.visibleWindowCount <= 1) {
    return params.countdown ?? params.label;
  }
  if (params.countdown === null) return params.label;
  return params.labelIsDuration
    ? params.countdown
    : `${params.label} ${params.countdown}`;
}
