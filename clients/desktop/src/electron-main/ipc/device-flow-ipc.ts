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

  bridge.handleInvoke(RunnerHostInvoke.deviceFlowStart, async (event) => {
    const windowId = bridge.resolveSenderWindowId(event);
    const sender = event.sender;
    const deliver = (
      attemptId: string,
      result: DeviceFlowResultPayload,
    ): void => {
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

    const outcome = await controller.start({ onResult: deliver });
    if (outcome.ok) {
      // Stop the loop if the owner window goes away before it settles.
      sender.once("destroyed", () => controller.cancel(outcome.attemptId));
    }
    return outcome;
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
    },
  );

  bridge.disposeFns.push(() => {
    controller.disposeAll();
  });
}
