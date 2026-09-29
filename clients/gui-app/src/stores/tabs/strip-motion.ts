import { tabRefKey } from "./layout";
import type { TabRef } from "./types";

/**
 * The motion the top tab strip plays for the tab changes a person makes.
 *
 * The coordinator marks what it opened, reopened or is about to close, and
 * the strip reads those marks as its items mount or leave. A tab that appears
 * or disappears any other way - hydration, a split pairing, a draft that
 * becomes a task, a reorder - carries no mark, so it never animates. Marking
 * the gesture rather than diffing the layout is what keeps those structural
 * changes still.
 */

/** Reopened tabs open left to right this far apart... */
const REOPEN_STAGGER_MS = 30;
/** ...and all of them have started by this point, however many there are. */
const REOPEN_STAGGER_CAP_MS = 240;
/** A group chip that comes back with its tabs opens first; they follow. */
const GROUP_LEAD_MS = 60;
/**
 * A mark the strip has not read by then belongs to a change it never drew:
 * the tabs sit in a side strip, or the item was collapsed into its group.
 */
const MARK_TTL_MS = 1000;

export interface StripEntrance {
  readonly delayMs: number;
}

interface Mark {
  readonly delayMs: number;
  readonly markedAt: number;
}

const entrances = new Map<string, Mark>();
const reopenGlows = new Map<string, number>();
const closingListeners = new Set<() => void>();

export function stripGroupMarkKey(groupId: string): string {
  return `group:${groupId}`;
}

function isFresh(markedAt: number): boolean {
  return performance.now() - markedAt < MARK_TTL_MS;
}

/**
 * Marks for a strip that never drew them (a side strip, a tab collapsed into
 * its group) would otherwise pile up; each new gesture sweeps the old ones.
 */
function sweepStaleMarks(): void {
  for (const [key, mark] of entrances)
    if (!isFresh(mark.markedAt)) entrances.delete(key);
  for (const [key, markedAt] of reopenGlows)
    if (!isFresh(markedAt)) reopenGlows.delete(key);
}

/** Tabs an ordinary open added to the strip. */
export function markOpenedTabs(refs: ReadonlyArray<TabRef>): void {
  sweepStaleMarks();
  const markedAt = performance.now();
  for (const ref of refs)
    entrances.set(tabRefKey(ref), { delayMs: 0, markedAt });
}

/**
 * Tabs a reopen put back, in strip order. `returningGroupIds` are the groups
 * the reopen recreated, whose chips lead their tabs back in. A single reopened
 * tab also earns the join glow once it is selected, so the eye finds it.
 */
export function markReopenedTabs(input: {
  readonly refs: ReadonlyArray<TabRef>;
  readonly returningGroupIds: ReadonlyArray<string>;
}): void {
  sweepStaleMarks();
  const markedAt = performance.now();
  const lead = input.returningGroupIds.length > 0 ? GROUP_LEAD_MS : 0;
  for (const groupId of input.returningGroupIds) {
    entrances.set(stripGroupMarkKey(groupId), { delayMs: 0, markedAt });
  }
  input.refs.forEach((ref, index) => {
    entrances.set(tabRefKey(ref), {
      delayMs:
        lead + Math.min(index * REOPEN_STAGGER_MS, REOPEN_STAGGER_CAP_MS),
      markedAt,
    });
  });
  if (input.refs.length === 1) {
    const [only] = input.refs;
    reopenGlows.set(tabRefKey(only), markedAt);
  }
}

/**
 * The entrance marked for any of `keys` (a split carries two refs). Read, not
 * consumed: StrictMode runs a mount effect, cleans it up and runs it again,
 * and the second run must still find the mark. `settleStripEntrance` clears
 * it once the slot has opened, and a mark nobody settles expires.
 */
export function peekStripEntrance(
  keys: ReadonlyArray<string>,
): StripEntrance | null {
  let entrance: StripEntrance | null = null;
  for (const key of keys) {
    const mark = entrances.get(key);
    if (mark === undefined || !isFresh(mark.markedAt)) continue;
    if (entrance === null || mark.delayMs < entrance.delayMs) {
      entrance = { delayMs: mark.delayMs };
    }
  }
  return entrance;
}

export function settleStripEntrance(keys: ReadonlyArray<string>): void {
  for (const key of keys) entrances.delete(key);
}

/** Whether a single reopen of any of `keys` is still owed its glow. */
export function takeReopenGlow(keys: ReadonlyArray<string>): boolean {
  let owed = false;
  for (const key of keys) {
    const markedAt = reopenGlows.get(key);
    if (markedAt === undefined) continue;
    reopenGlows.delete(key);
    if (isFresh(markedAt)) owed = true;
  }
  return owed;
}

/**
 * Called just before the coordinator removes tabs the person closed, while
 * the strip still paints them, so the strip can hold their space and let it
 * close up rather than jump.
 */
export function markClosingTabs(): void {
  for (const listener of closingListeners) listener();
}

export function subscribeClosingTabs(listener: () => void): () => void {
  closingListeners.add(listener);
  return () => {
    closingListeners.delete(listener);
  };
}

export function resetStripMotionForTesting(): void {
  entrances.clear();
  reopenGlows.clear();
  closingListeners.clear();
}
