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

/**
 * How long the update door waits for every window to answer before treating
 * the unanswered ones as unknown.
 *
 * Deliberately more generous than the quit path's 200ms. That budget is set
 * by an OS shutdown the app is already inside, and overrunning it risks the
 * quit itself; this one is a user who just clicked Install on an app that is
 * about to restart anyway, so the only cost of waiting is the wait. Spending
 * it buys a real answer instead of a "could not check the other windows"
 * prompt, which - being the fail-closed direction - is what a too-short
 * timeout would show on every click.
 */
const UPDATE_FRESH_UNSYNCED_SNAPSHOT_TIMEOUT_MS = 500;

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
    // A FRESH fan-out, not the ambient per-window map.
    //
    // This used to read the ambient map, on the reasoning that retention
    // changes on a re-point rather than on a keystroke, so a debounced push
    // was current enough. That confuses how OFTEN the state changes with how
    // CLOSELY a change can precede this question. A re-point that retains a
    // buffer in window B is followed by a 100ms debounce and an IPC hop before
    // main hears about it, and nothing stops window A's Update click from
    // landing inside that window - at which point the aggregate says "no
    // unsyncable work", the caller installs with no prompt, and the restart
    // destroys the buffer this check exists to protect. Rare is not the same
    // as safe when the loss is unrecoverable.
    //
    // The renderer's `getFreshUnsyncedSnapshot` handler cancels its own
    // pending ambient push and reads the registry synchronously, so the round
    // trip does not merely wait the debounce out - it bypasses it.
    //
    // The old objection to fanning out was that it makes the Update button
    // wait on the slowest renderer "and time out into exactly the wrong
    // answer". The wait is now bounded by `UPDATE_FRESH_UNSYNCED_SNAPSHOT_
    // TIMEOUT_MS`, and a timeout no longer produces an answer at all: it is
    // reported as `otherWindowsUnknown` and the caller must ask the user.
    bridge
      .requestFreshUnsyncedSnapshotWithFidelity(
        UPDATE_FRESH_UNSYNCED_SNAPSHOT_TIMEOUT_MS,
      )
      .then((result) => ({
        epics: result.snapshot.filter((entry) => entry.unsyncable),
        otherWindowsUnknown: result.anyWindowStale,
      })),
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
