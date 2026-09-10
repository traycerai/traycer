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
 * Non-strings are dropped rather than throwing the invoke. A malformed report
 * that rejected would leave the reporting window's LAST report standing, which
 * says a pane is visible that may not be; dropping the bad ids and keeping the
 * well-formed ones fails toward "less is visible", which is the direction that
 * lets parking still happen.
 */
function parseEpicIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}
