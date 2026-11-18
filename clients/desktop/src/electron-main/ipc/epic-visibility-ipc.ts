import { app } from "electron";
import { z } from "zod";
import { log } from "../app/logger";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { EpicVisibilityEntry } from "../../ipc-contracts/window-types";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

/**
 * The cross-window visible-Epic channel (plan C, decision C6).
 *
 * One invoke in - a window reporting its own roll-up - and one event out, the
 * whole per-window map fanned to every window. The map rather than a union
 * because the receiving renderer has to be able to EXCLUDE ITSELF: its own row
 * here is an echo of a fact it already knows first-hand, and treating that echo
 * as evidence would leave the park window armed a round trip late (or, worse,
 * never armed, if a report and a hide crossed).
 */
export function registerEpicVisibilityIpc(bridge: RunnerIpcBridge): void {
  // The startup read, and NOT redundant with the fan-out below. The replay in
  // `replayCurrentStateToWindow` is triggered by the SYNC `windowId` read,
  // which the preload performs while it is building the bridge - long before
  // any renderer effect has subscribed - so a window that relied on the replay
  // alone would start with an empty map and could park an epic another window
  // is showing. `ownership` carries a `snapshot()` for the same reason.
  bridge.handleInvoke(RunnerHostInvoke.epicVisibilitySnapshot, () => {
    return bridge.epicVisibility.snapshot();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.epicVisibilityReport,
    (event, epicIds: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] epicVisibility.report from unknown window", {});
        return;
      }
      bridge.epicVisibility.report(windowId, parseEpicIds(epicIds));
    },
  );

  // A crashed renderer's row, for EVERY window rather than the ones that
  // happen to hold browser tiles.
  //
  // `markRendererUnavailable` already clears this row, but it is reached
  // through the browser-view attachment's own `render-process-gone` listener,
  // and that listener is attached lazily the first time a tile attaches to a
  // window and detached again when the last one goes. A window that never
  // opened a browser tile therefore has no such listener, so a renderer that
  // crashes there and never returns would leave its last visible-Epic report
  // standing until the window was closed - blocking every other window from
  // parking those Epics for exactly as long.
  //
  // Deliberately narrower than `markRendererUnavailable`: this clears the
  // visibility row and nothing else. Quit interception and the snapshot
  // waiters have their own liveness rules, and widening this hook to them
  // would change shutdown behaviour that has nothing to do with parking.
  const onRenderProcessGone = (
    _event: unknown,
    contents: { id: number },
  ): void => {
    const windowId = bridge.windowRegistry.getRecordByWebContentsId(
      contents.id,
    )?.windowId;
    if (windowId === undefined) return;
    bridge.epicVisibility.report(windowId, []);
  };
  app.on("render-process-gone", onRenderProcessGone);
  bridge.disposeFns.push(() => {
    app.off("render-process-gone", onRenderProcessGone);
  });

  const onEpicVisibilityChange = (
    snapshot: readonly EpicVisibilityEntry[],
  ): void => {
    bridge.fanOut(RunnerHostEvent.epicVisibilityChange, snapshot);
  };
  bridge.epicVisibility.on("change", onEpicVisibilityChange);
  bridge.disposeFns.push(() => {
    bridge.epicVisibility.off("change", onEpicVisibilityChange);
  });

  bridge.fanOut(
    RunnerHostEvent.epicVisibilityChange,
    bridge.epicVisibility.snapshot(),
  );
}

/**
 * A malformed report is REJECTED whole, and the reporting window's previous row
 * stands.
 *
 * This used to drop the bad ids and keep the rest, on the reasoning that
 * failing toward "less is visible" was the direction that still let parking
 * happen. That had the danger backwards. Under-reporting is exactly what makes
 * some OTHER window park an Epic this one is showing, which is the bug this
 * whole channel exists to fix; a row that over-reports only defers a park.
 * Filtering to empty is worse still, because {@link EpicWindowVisibility.report}
 * reads an empty set as the ABSENCE of a row.
 *
 * Rejecting surfaces as a rejected invoke, which the renderer already treats as
 * a failed report and retries with the ids re-read at retry time - so a
 * transient bad frame self-corrects instead of silently standing.
 *
 * Bounded because every id is echoed into a map key, a log line, and a fan-out
 * to every window: a compromised renderer must not be able to retain arbitrary
 * data in main or amplify IPC work across the fleet. The length bound matches
 * the one `browser-view-ipc-payload.ts` applies to a renderer-supplied Epic id,
 * and is redeclared here rather than shared for the reason stated there - it is
 * a local echo bound, not a protocol fact.
 */
const MAX_RENDERER_EPIC_ID_LENGTH = 128;
const MAX_VISIBLE_EPIC_IDS = 256;

const epicIdsSchema = z
  .array(z.string().min(1).max(MAX_RENDERER_EPIC_ID_LENGTH))
  .max(MAX_VISIBLE_EPIC_IDS);

function parseEpicIds(value: unknown): readonly string[] {
  return epicIdsSchema.parse(value);
}
