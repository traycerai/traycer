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
