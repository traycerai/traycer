import { app } from "electron";
import { log } from "../app/logger";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type {
  UnsyncedEditsSnapshot,
  UnsyncedEditsSnapshotEntry,
} from "../../ipc-contracts/app-lifecycle-types";
import {
  parseFreshSnapshotResponse,
  parseQuitDecisionResponse,
  parseRequestId,
  parseUnsyncedSnapshot,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerLifecycleIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.appLifecycleQuit, () => {
    log.info("[runner-ipc] app quit requested by renderer");
    app.quit();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.setUnsyncedEditsSnapshot,
    (event, snapshot: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn(
          "[runner-ipc] setUnsyncedEditsSnapshot from unknown window",
          {},
        );
        return;
      }
      bridge.appLifecycleReadyWindowIds.add(windowId);
      bridge.unsyncedEditsSnapshots.set(
        windowId,
        parseUnsyncedSnapshot(snapshot),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.respondToQuitRequest,
    (event, response: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] respondToQuitRequest from unknown window", {});
        return;
      }
      const parsed = parseQuitDecisionResponse(response);
      const waiterIndex = parsed.legacy
        ? bridge.quitDecisionWaiters.findIndex(
            (entry) => entry.windowId === windowId,
          )
        : bridge.quitDecisionWaiters.findIndex(
            (entry) =>
              entry.windowId === windowId &&
              entry.requestId === parsed.requestId,
          );
      const waiter =
        waiterIndex === -1
          ? undefined
          : bridge.quitDecisionWaiters.splice(waiterIndex, 1)[0];
      if (waiter !== undefined) {
        clearTimeout(waiter.serviceTimer);
        waiter.resolve(parsed.decision);
      } else {
        log.warn("[runner-ipc] respondToQuitRequest received with no waiter", {
          decision: parsed.decision,
          requestId: parsed.requestId,
          windowId,
        });
      }
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.acknowledgeQuitRequest,
    (event, requestId: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] acknowledgeQuitRequest from unknown window", {});
        return;
      }
      const parsedRequestId = parseRequestId(requestId);
      if (parsedRequestId === null) {
        log.warn("[runner-ipc] acknowledgeQuitRequest payload malformed", {
          requestId,
          windowId,
        });
        return;
      }
      const waiter = bridge.quitDecisionWaiters.find(
        (entry) =>
          entry.windowId === windowId && entry.requestId === parsedRequestId,
      );
      if (waiter !== undefined) {
        clearTimeout(waiter.serviceTimer);
        return;
      }
      log.warn("[runner-ipc] acknowledgeQuitRequest received with no waiter", {
        requestId: parsedRequestId,
        windowId,
      });
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.unsyncableWorkAcrossWindows, () =>
    // Reads the AMBIENT per-window map rather than issuing a fresh-snapshot
    // round trip to every window. Deliberate: the renderers push on a 100ms
    // debounce off their own registry, and the state being asked about -
    // whether a buffer was RETAINED across a re-point - changes on a re-point,
    // not on a keystroke. A fan-out with a per-window timeout would make a
    // button that installs an update wait on the slowest renderer in the app,
    // and time out into exactly the wrong answer.
    bridge.getUnsyncedEditsSnapshot().filter((entry) => entry.unsyncable),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.freshUnsyncedSnapshotResponse,
    (event, payload: unknown) => {
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn(
          "[runner-ipc] freshUnsyncedSnapshotResponse from unknown window",
          {},
        );
        return;
      }
      const parsed = parseFreshSnapshotResponse(payload);
      if (parsed === null) {
        log.warn(
          "[runner-ipc] freshUnsyncedSnapshotResponse payload malformed",
          { payload },
        );
        return;
      }
      const waiter = bridge.freshSnapshotWaiters.get(parsed.requestId);
      if (waiter === undefined) {
        // Late reply or a reply from a prior request whose timeout already
        // fired. Safe to drop.
        return;
      }
      if (waiter.windowId !== windowId) {
        log.warn(
          "[runner-ipc] freshUnsyncedSnapshotResponse from wrong window",
          { expectedWindowId: waiter.windowId, windowId },
        );
        return;
      }
      bridge.freshSnapshotWaiters.delete(parsed.requestId);
      bridge.appLifecycleReadyWindowIds.add(windowId);
      bridge.unsyncedEditsSnapshots.set(windowId, parsed.snapshot);
      waiter.resolve(parsed.snapshot);
    },
  );
}

export function aggregateUnsyncedSnapshots(
  snapshots: readonly UnsyncedEditsSnapshot[],
): UnsyncedEditsSnapshot {
  const byEpicId = new Map<string, UnsyncedEditsSnapshotEntry>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot) {
      const current = byEpicId.get(entry.epicId);
      byEpicId.set(
        entry.epicId,
        current === undefined
          ? entry
          : {
              epicId: entry.epicId,
              title: entry.title,
              queueSize: Math.max(current.queueSize, entry.queueSize),
              isDirty: current.isDirty || entry.isDirty,
              // OR, like `isDirty`: one window holding a retained buffer for
              // this Epic makes the Epic unsyncable for the whole app, and the
              // app is what an update install restarts.
              unsyncable: current.unsyncable || entry.unsyncable,
            },
      );
    }
  }
  return Array.from(byEpicId.values());
}
