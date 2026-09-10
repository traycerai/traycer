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
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { appLogger } from "@/lib/logger";

/**
 * Epics some OTHER window is showing. Empty whenever no channel is installed,
 * which is what makes every consumer's `||` inert off the desktop.
 */
let epicsVisibleElsewhere: ReadonlySet<string> = new Set<string>();
const listeners = new Set<(epicId: string) => void>();

/**
 * Backoff for a failed leg of the channel, and the length of the array IS the
 * budget - see {@link installCrossWindowEpicVisibility}.
 */
const RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];

interface BoundedRetry {
  /** Cancel anything pending, reset the budget, and attempt again now. */
  restart(): void;
  cancel(): void;
}

/**
 * Run `attempt` until it resolves, at most {@link RETRY_DELAYS_MS} times.
 *
 * Bounded because a channel that is broken rather than blipping must not spin
 * forever. Giving up restores the pre-retry behaviour for that leg rather than
 * anything worse, and the budget resets on the next `restart`.
 *
 * CANCELLING IS ABOUT THE ATTEMPT, NOT ONLY ABOUT THE TIMER. The pending
 * `attempt()` promise is the half a `clearTimeout` cannot reach, and it is the
 * half that outlives teardown: an invoke still in flight when the window
 * uninstalls rejects afterwards, lands in the catch, and arms a timer that
 * reports through a channel nobody owns any more. Each attempt therefore
 * carries the generation it was started in, and a completion whose generation
 * has moved on is not this retry's news - neither its failure (no timer) nor
 * its success (no budget reset, which would otherwise hand a stale resolve the
 * power to un-exhaust a live leg's budget).
 */
function createBoundedRetry(
  label: string,
  attempt: () => Promise<void>,
): BoundedRetry {
  let timer: number | null = null;
  let failures = 0;
  let generation = 0;
  const cancel = (): void => {
    generation += 1;
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const run = (): void => {
    const attemptGeneration = generation;
    const superseded = (): boolean => attemptGeneration !== generation;
    void attempt()
      .then(() => {
        if (superseded()) return;
        failures = 0;
      })
      .catch((error: unknown) => {
        if (superseded()) return;
        appLogger.warn(`[epic-visibility] cross-window ${label} failed`, {
          error: error instanceof Error ? error.message : "unknown error",
          attempt: failures,
        });
        if (failures >= RETRY_DELAYS_MS.length) return;
        const delayMs = RETRY_DELAYS_MS[failures];
        failures += 1;
        timer = window.setTimeout(() => {
          timer = null;
          run();
        }, delayMs);
      });
  };
  return {
    restart: (): void => {
      cancel();
      failures = 0;
      run();
    },
    cancel,
  };
}

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
  const lifecycle = { cancelled: false, fanOutSeen: false };
  // BOTH legs of this channel retry, and they are one defect rather than two.
  // Each is a fire-and-forget promise carrying a fact the cross-window answer
  // depends on, and the reasoning that let them drop it was wrong in the same
  // way: it assumed some later event would carry the fact again.
  //
  // Outbound, "main keeps this window's previous set" is only benign on a
  // visible->hidden edge, where the stale row over-reports and merely defers a
  // park. On a HIDDEN->VISIBLE edge the stale row says this window shows
  // nothing and another window will park an Epic that is on screen here - and
  // the correction was supposed to arrive on "the next visibility edge", which
  // a pane that is simply left open never produces.
  //
  // Inbound is worse, because the startup read has no self-correcting edge at
  // all: what it is missing is what OTHER windows show, and that only arrives
  // when one of THEM changes. A window B sitting still on an Epic is exactly
  // the case where nothing ever arrives, so a dropped snapshot leaves window A
  // parking an Epic that is on screen for as long as B holds still.
  // What this window CLAIMS, which is not the same as what it has placed. A
  // minimized or fully occluded window still has a front pane per
  // `visibleEpicIds()` - that set is surface placement inside this renderer and
  // cannot see the window - so reporting it unconditionally left every other
  // window believing these Epics were on screen here, and holding off parking
  // them, for as long as this one stayed hidden. A hidden window claims
  // nothing.
  //
  // Both halves are read HERE, at attempt time, for the same reason the ids
  // already were: a retry that fires after the window was minimized (or
  // restored) must send what is true when it sends, not what was true when it
  // was armed.
  const reportableEpicIds = (): readonly string[] =>
    isDocumentVisible() ? visibleEpicIds() : [];
  const reportLeg = createBoundedRetry("report", () =>
    channel.report(reportableEpicIds()),
  );
  // Behind a call rather than read inline, and not for tidiness: TypeScript
  // narrows both flags to `false` at the first guard and does NOT widen that
  // narrowing across the `await`, so an inline second guard type-checks as dead
  // code and the type-aware lint rejects it. The flags genuinely do change
  // while the snapshot is in flight - that is the entire point of the second
  // check - so the answer has to be re-derived by a call the compiler cannot
  // narrow through.
  const snapshotSuperseded = (): boolean =>
    lifecycle.cancelled || lifecycle.fanOutSeen;
  const snapshotLeg = createBoundedRetry("snapshot", async () => {
    // Re-checked on BOTH sides of the await: a fan-out that lands while the
    // snapshot is in flight is newer, and applying the resolved map after it
    // would put the older answer back. Resolving without publishing also ends
    // the retries, which is right - the fact arrived by the better route.
    if (snapshotSuperseded()) return;
    const entries = await channel.snapshot();
    if (snapshotSuperseded()) return;
    publish(foreignVisibleEpics(entries, ownWindowId));
  });
  const report = (): void => {
    // A fresh edge supersedes whatever the pending attempt was carrying, and
    // restarts the budget: this is a new fact, not a continuation of the failed
    // one. A slow completion from the superseded attempt is dropped by
    // `restart`'s generation bump rather than arming a retry behind the live
    // one.
    reportLeg.restart();
  };
  const subscription = channel.onChange((entries) => {
    lifecycle.fanOutSeen = true;
    publish(foreignVisibleEpics(entries, ownWindowId));
  });
  const unsubscribeLocal = subscribeEpicSurfaceVisibility(report);
  // The window hiding or returning changes what we claim without changing what
  // we have placed, so `subscribeEpicSurfaceVisibility` never fires for it. Its
  // edge is the only thing that withdraws the claim on the way out and
  // republishes it on the way back; without this the empty set would be sent
  // only if some pane happened to move while hidden.
  const unsubscribeDocument = subscribeDocumentVisibility(report);
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
  snapshotLeg.restart();
  return () => {
    lifecycle.cancelled = true;
    reportLeg.cancel();
    snapshotLeg.cancel();
    unsubscribeLocal();
    unsubscribeDocument();
    subscription.dispose();
    publish(new Set<string>());
  };
}

/** Forget the cross-window answer and every watcher's view of it. */
export function __resetCrossWindowEpicVisibilityForTests(): void {
  publish(new Set<string>());
}
