import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import { assertString } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import {
  DeviceFlowController,
  type DeviceFlowResultPayload,
} from "../auth/device-flow-controller";

/**
 * Wires the renderer-facing device-flow IPC to the main-process
 * `DeviceFlowController`. `deviceFlowStart` authorizes + starts the poll loop
 * and returns the authorization; the terminal outcome is pushed on
 * `deviceFlowResult` keyed by `attemptId`. `deviceFlowPollNow` nudges the loop
 * to poll immediately (the browser-return deep link). `deviceFlowCancel` aborts
 * the loop.
 *
 * The poll loop is owned by the window that started it: when that window's
 * `webContents` is destroyed we cancel the attempt, so closing a window mid
 * device-flow never leaks a 10-minute poll (Finding 9).
 */
export function registerDeviceFlowIpc(bridge: RunnerIpcBridge): void {
  const controller = new DeviceFlowController(bridge.options.authnBaseUrl);
  // Tracks each started attempt's owner-window listener cleanup so EVERY
  // terminal path removes it exactly once: `deviceFlowCancel`, `disposeAll`, and
  // a thrown `controller.start()` would otherwise leave stale `destroyed`
  // listeners accumulating across repeated cancelled sign-ins.
  const cleanupByAttemptId = new Map<string, () => void>();

  bridge.handleInvoke(RunnerHostInvoke.deviceFlowStart, async (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    const sender = event.sender;
    // Watch the owner window for the WHOLE attempt lifecycle, not just after
    // `start()` resolves: a window closed mid-`/device/authorize` would
    // otherwise leave the poll loop running once the attempt id lands. The
    // listener is removed on the terminal result (and on a failed start) so
    // repeated sign-ins don't accumulate stale `destroyed` listeners.
    let startedAttemptId: string | null = null;
    let senderDestroyed = false;
    const onSenderDestroyed = (): void => {
      senderDestroyed = true;
      if (startedAttemptId !== null) {
        controller.cancel(startedAttemptId);
      }
    };
    const cleanupSenderDestroyedListener = (): void => {
      sender.removeListener("destroyed", onSenderDestroyed);
      if (startedAttemptId !== null) {
        cleanupByAttemptId.delete(startedAttemptId);
      }
    };
    sender.once("destroyed", onSenderDestroyed);
    const deliver = (
      attemptId: string,
      result: DeviceFlowResultPayload,
    ): void => {
      cleanupSenderDestroyedListener();
      const payload = { attemptId, result };
      // Deliver to the window that started the attempt; device-flow results are
      // process-global (not Epic-scoped), so fall back to a broadcast if that
      // window can no longer be resolved.
      if (
        windowId === null ||
        !bridge.safeSendToWindow(
          windowId,
          RunnerHostEvent.deviceFlowResult,
          payload,
        )
      ) {
        bridge.fanOut(RunnerHostEvent.deviceFlowResult, payload);
      }
    };

    try {
      const outcome = await controller.start({ onResult: deliver });
      if (outcome.ok) {
        startedAttemptId = outcome.attemptId;
        cleanupByAttemptId.set(
          outcome.attemptId,
          cleanupSenderDestroyedListener,
        );
        // The window may have closed while `/device/authorize` was in flight -
        // before we had an attempt id to cancel - so reconcile now (and tear
        // down the listener, since the attempt is already cancelled).
        if (senderDestroyed || sender.isDestroyed()) {
          controller.cancel(outcome.attemptId);
          cleanupSenderDestroyedListener();
        }
      } else {
        cleanupSenderDestroyedListener();
      }
      return outcome;
    } catch (err) {
      // A thrown `start()` (e.g. abort during shutdown) is still a terminal
      // path: remove the listener so it can't leak.
      cleanupSenderDestroyedListener();
      throw err;
    }
  });

  bridge.handleInvoke(
    RunnerHostInvoke.deviceFlowPollNow,
    (_event, attemptId: unknown) => {
      assertString(attemptId, "deviceFlowPollNow");
      controller.pollNow(attemptId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.deviceFlowCancel,
    (_event, attemptId: unknown) => {
      assertString(attemptId, "deviceFlowCancel");
      controller.cancel(attemptId);
      cleanupByAttemptId.get(attemptId)?.();
    },
  );

  bridge.disposeFns.push(() => {
    for (const cleanup of cleanupByAttemptId.values()) {
      cleanup();
    }
    cleanupByAttemptId.clear();
    controller.disposeAll();
  });
}
