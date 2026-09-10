/**
 * "Is a pane of this Epic visible in ANOTHER window?" - the half of decision
 * C6's visible-if-any rule that one renderer cannot answer for itself.
 *
 * `lib/browser-view/tiles/surface-host-opened-tab.ts` holds this window's own
 * visible-view registry, and it is module state: every Electron
 * `BrowserWindow` is a separate renderer with a separate copy, so window A's
 * roll-up is structurally invisible to window B. Desktop Epic ownership does
 * not close the gap either - `EpicWindowOwnership.claim` keys on `tabId` and
 * the claim path never consults `getOwnerForEpic` - so two windows genuinely
 * can hold live sessions for one Epic, and without this channel window A would
 * park an Epic window B is showing.
 *
 * ## The shape
 *
 * Each window reports its OWN roll-up to main on every change; main holds one
 * set per window and fans the whole map back. This module owns both legs and
 * publishes one predicate, {@link isEpicVisibleInAnotherWindow}, which the
 * parking decider ORs with its local reading.
 *
 * ## Two things this deliberately does not do
 *
 * It does not read `ownership.snapshot()`. That is the cheap-looking fix and it
 * is a trap: it is async, and it reports every tab for the Epic INCLUDING
 * hidden ones - turning "another window is showing this" into "another window
 * has it open", which would disable parking for the whole multi-window case.
 *
 * It does not count THIS window's own row in the map main sends back. That row
 * is an echo of a fact this renderer knows first-hand and synchronously; taking
 * it as evidence would make the local visible->hidden edge wait a full round
 * trip before the park window could arm, and a report crossing a hide would
 * leave the echo standing until some unrelated change corrected it.
 *
 * ## Degrading
 *
 * Absent bridge (browser, or a preload built before the channel existed):
 * every read answers `false` and every report is dropped, so parking falls back
 * to this window's own panes. That is the correct answer in a browser - there
 * is no second window - and the pre-channel behaviour on desktop.
 */
import type {
  DesktopEpicVisibilityEntry,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import {
  subscribeEpicSurfaceVisibility,
  visibleEpicIds,
} from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { appLogger } from "@/lib/logger";

/**
 * Epics some OTHER window is showing. Empty whenever no channel is installed,
 * which is what makes every consumer's `||` inert off the desktop.
 */
let epicsVisibleElsewhere: ReadonlySet<string> = new Set<string>();
const listeners = new Set<(epicId: string) => void>();

export function isEpicVisibleInAnotherWindow(epicId: string): boolean {
  return epicsVisibleElsewhere.has(epicId);
}

/**
 * Watch the cross-window answer. The listener is handed each Epic whose answer
 * CHANGED, matching `subscribeEpicSurfaceVisibility`'s per-epic shape so the
 * parking decider can treat the two sources identically.
 */
export function subscribeCrossWindowEpicVisibility(
  listener: (epicId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: ReadonlySet<string>): void {
  const changed: string[] = [];
  for (const epicId of next) {
    if (!epicsVisibleElsewhere.has(epicId)) changed.push(epicId);
  }
  for (const epicId of epicsVisibleElsewhere) {
    if (!next.has(epicId)) changed.push(epicId);
  }
  epicsVisibleElsewhere = next;
  if (changed.length === 0) return;
  for (const listener of Array.from(listeners)) {
    for (const epicId of changed) {
      listener(epicId);
    }
  }
}

function foreignVisibleEpics(
  entries: readonly DesktopEpicVisibilityEntry[],
  ownWindowId: string,
): ReadonlySet<string> {
  const foreign = new Set<string>();
  for (const entry of entries) {
    if (entry.windowId === ownWindowId) continue;
    for (const epicId of entry.epicIds) {
      foreign.add(epicId);
    }
  }
  return foreign;
}

/**
 * Wire this renderer into the channel for the life of a desktop bridge.
 * Returns the teardown, which also drops the cross-window answer back to
 * empty: a renderer with no channel must not keep answering from the last map
 * it happened to receive.
 */
export function installCrossWindowEpicVisibility(
  bridge: DesktopWindowsBridge,
): () => void {
  const channel = bridge.epicVisibility;
  // Probed rather than required by `isDesktopWindowsBridge` - see the field's
  // own doc. A preload without it costs parking its cross-window arm and
  // nothing else.
  if (channel === undefined) return () => undefined;
  const ownWindowId = bridge.windowId;
  const report = (): void => {
    void channel.report(visibleEpicIds()).catch((error: unknown) => {
      // Best effort by construction: a dropped report leaves main holding this
      // window's previous set, which errs toward "still visible" and therefore
      // toward NOT parking - the safe direction, and self-correcting on the
      // next visibility edge.
      appLogger.warn("[epic-visibility] cross-window report failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
  };
  const lifecycle = { cancelled: false, fanOutSeen: false };
  const subscription = channel.onChange((entries) => {
    lifecycle.fanOutSeen = true;
    publish(foreignVisibleEpics(entries, ownWindowId));
  });
  const unsubscribeLocal = subscribeEpicSurfaceVisibility(report);
  // The set this window is showing at install time, which no edge will
  // announce: a restored window mounts its surfaces before this runs.
  report();
  // The STARTUP read, and the subscription above cannot stand in for it. Main
  // replays its map on the SYNC `windowId` read, which the preload performs
  // while building the bridge - so that replay has already been sent and
  // dropped by the time this effect runs, and the next fan-out only happens
  // when some window's set CHANGES. Without this a freshly opened window
  // starts believing no other window shows anything, and could park an epic
  // one of them has on screen.
  //
  // Applied only if no fan-out has landed in the meantime: a snapshot resolved
  // after a live change would put the older map back.
  void channel
    .snapshot()
    .then((entries) => {
      if (lifecycle.cancelled || lifecycle.fanOutSeen) return;
      publish(foreignVisibleEpics(entries, ownWindowId));
    })
    .catch((error: unknown) => {
      appLogger.warn("[epic-visibility] cross-window snapshot failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
  return () => {
    lifecycle.cancelled = true;
    unsubscribeLocal();
    subscription.dispose();
    publish(new Set<string>());
  };
}

/** Forget the cross-window answer and every watcher's view of it. */
export function __resetCrossWindowEpicVisibilityForTests(): void {
  publish(new Set<string>());
}
