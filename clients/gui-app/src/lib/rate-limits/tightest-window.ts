/**
 * Which of a provider's readings binds it hardest right now.
 *
 * Its own module because two surfaces have to agree on the answer: the strip,
 * where the tightest window is what a segment collapses to and what the
 * automatic selection contributes, and Settings ▸ Layout's limit list, whose
 * `Tightest limit (automatic)` entry shows that window's figure. A second
 * comparator would let the list name one limit while the strip drew another,
 * which is the one thing that entry promises cannot happen.
 *
 * Generic over the reading, so each caller keeps its own shape - the strip's
 * segment window, the list's catalog entry joined with its reading - and gets
 * that shape back rather than a lowest common denominator it has to look up
 * again.
 */

/** The two facts tightness is decided by, and nothing else. */
export interface RateLimitWindowTightness {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

/**
 * Whether `candidate` binds this provider harder than `incumbent` does: the
 * higher used percentage, then the sooner reset, then whichever the catalog
 * reported first.
 *
 * A window with no `resetsAt` loses that second comparison to one that has a
 * reset instant, rather than being treated as infinitely far away - "soonest"
 * is a question an unknown reset cannot answer, and preferring the window that
 * CAN answer it is what keeps the compact form informative.
 */
export function isTighterRateLimitWindow(
  candidate: RateLimitWindowTightness,
  incumbent: RateLimitWindowTightness,
): boolean {
  if (candidate.usedPercent !== incumbent.usedPercent) {
    return candidate.usedPercent > incumbent.usedPercent;
  }
  if (candidate.resetsAt === null) return false;
  if (incumbent.resetsAt === null) return true;
  return candidate.resetsAt < incumbent.resetsAt;
}

export function tightestRateLimitWindow<
  Window extends RateLimitWindowTightness,
>(windows: ReadonlyArray<Window>): Window | null {
  return windows.reduce<Window | null>(
    (tightest, window) =>
      tightest === null || isTighterRateLimitWindow(window, tightest)
        ? window
        : tightest,
    null,
  );
}
