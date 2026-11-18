import { log } from "../app/logger";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { OwnershipEntry } from "../../ipc-contracts/window-types";
import { assertString } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerOwnershipIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(RunnerHostInvoke.ownershipSnapshot, () => {
    return bridge.ownership.snapshot();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.ownershipClaim,
    (event, tabId: unknown, epicId: unknown) => {
      assertString(tabId, "ownership.claim");
      assertString(epicId, "ownership.claim");
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] ownership.claim from unknown window", {});
        return { ok: false, currentOwner: "" };
      }
      const result = bridge.ownership.claim(tabId, epicId, windowId);
      if (!result.ok) {
        bridge.windowRegistry.focusById(result.currentOwner);
      }
      return result;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.ownershipRelease,
    (event, tabId: unknown) => {
      assertString(tabId, "ownership.release");
      const windowId = bridge.resolveSenderWindowId(event);
      if (windowId === null) {
        log.warn("[runner-ipc] ownership.release from unknown window", {});
        return;
      }
      bridge.ownership.release(tabId, windowId);
    },
  );

  const onOwnershipChange = (snapshot: readonly OwnershipEntry[]): void => {
    bridge.fanOut(RunnerHostEvent.ownershipChange, snapshot);
  };
  bridge.ownership.on("change", onOwnershipChange);
  bridge.disposeFns.push(() => {
    bridge.ownership.off("change", onOwnershipChange);
  });

  bridge.fanOut(RunnerHostEvent.ownershipChange, bridge.ownership.snapshot());
}
