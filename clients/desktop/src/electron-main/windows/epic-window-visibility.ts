import { EventEmitter } from "node:events";
import type { EpicVisibilityEntry } from "../../ipc-contracts/window-types";

type EpicVisibilityListener = (entries: readonly EpicVisibilityEntry[]) => void;

/**
 * Which Epics each renderer window currently shows, so the renderers can
 * answer "is a pane of this Epic visible in ANY window" (plan C, decision C6).
 *
 * Each renderer owns the answer for ITSELF - it is the only process that knows
 * which of its panes are on screen - and reports its own roll-up here on every
 * change. Main's job is only to hold one window's answer per window and fan the
 * set back out, which is the one thing no renderer can do for itself: a
 * `BrowserWindow` is its own renderer with its own module state, so window A's
 * visible-view registry is structurally invisible to window B.
 *
 * ## Not derived from ownership, and not persisted
 *
 * `EpicWindowOwnership` is the tempting source and is the wrong question twice
 * over. It keys on `tabId` and counts a HIDDEN tab exactly like a shown one, so
 * "another window is showing this" would become "another window has it open" -
 * which would disable parking for the entire multi-window case, the opposite of
 * the intent. It is also persisted across runs, and a restored visibility entry
 * would claim a pane is on screen in a window that does not exist yet.
 *
 * So this holds live state only, and a window that goes away simply stops
 * being in the map ({@link retainWindows}).
 */
export class EpicWindowVisibility {
  private readonly events = new EventEmitter();
  private readonly epicIdsByWindowId = new Map<string, ReadonlySet<string>>();

  /**
   * Replace one window's visible set. Emits only when that window's answer
   * actually changed - a renderer reports its whole roll-up on every visibility
   * edge, and most edges (a split pane flipping while its twin stays on screen)
   * do not move the set.
   */
  report(windowId: string, epicIds: readonly string[]): void {
    const next = new Set(epicIds);
    const current = this.epicIdsByWindowId.get(windowId);
    if (current !== undefined && setsAreEqual(current, next)) return;
    if (next.size === 0) {
      // An empty report is the absence of an entry, not an entry holding
      // nothing: `retainWindows` prunes by key, and a window that shows no
      // Epic must not keep a row alive that reads as a live participant.
      if (current === undefined) return;
      this.epicIdsByWindowId.delete(windowId);
    } else {
      this.epicIdsByWindowId.set(windowId, next);
    }
    this.emit();
  }

  /**
   * Drop every window outside `liveWindowIds`. Called from the registry-change
   * sweep, so a closed window stops claiming to show anything the moment it is
   * gone rather than when its renderer would have reported - which it never
   * will, having been destroyed.
   */
  retainWindows(liveWindowIds: ReadonlySet<string>): void {
    let removed = false;
    for (const windowId of Array.from(this.epicIdsByWindowId.keys())) {
      if (liveWindowIds.has(windowId)) continue;
      this.epicIdsByWindowId.delete(windowId);
      removed = true;
    }
    if (removed) this.emit();
  }

  snapshot(): readonly EpicVisibilityEntry[] {
    return Array.from(this.epicIdsByWindowId.entries()).map(
      ([windowId, epicIds]) => ({
        windowId,
        epicIds: Array.from(epicIds),
      }),
    );
  }

  on(event: "change", listener: EpicVisibilityListener): void {
    this.events.on(event, listener);
  }

  off(event: "change", listener: EpicVisibilityListener): void {
    this.events.off(event, listener);
  }

  private emit(): void {
    this.events.emit("change", this.snapshot());
  }
}

function setsAreEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
