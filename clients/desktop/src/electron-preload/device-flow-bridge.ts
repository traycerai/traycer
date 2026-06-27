import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DeviceFlowAuthorization,
  DeviceFlowResult,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable, Listener } from "./subscribe";

/**
 * Wire shape of `deviceFlowStart`'s response. `ok: false` collapses an
 * authorize failure (network/5xx) into a `null` session for the renderer.
 */
interface DeviceFlowStartResponse {
  readonly ok: boolean;
  readonly attemptId?: string;
  readonly authorization?: DeviceFlowAuthorization;
}

interface DeviceFlowResultEnvelope {
  readonly attemptId: string;
  readonly result: DeviceFlowResult;
}

/**
 * Per-attempt terminal-result routing. The main-process loop can settle before
 * the renderer subscribes (or the event can race the `start()` response), so a
 * result that arrives without a live handler is cached by `attemptId` and
 * replayed on the next `onResult`. Mirrors the cold-start replay cache in
 * `auth-bridge.ts`. Each `attemptId` settles exactly once, so an entry is
 * consumed-and-dropped on delivery and never accumulates.
 */
const resultHandlers = new Map<string, Listener<DeviceFlowResult>>();
const cachedResults = new Map<string, DeviceFlowResult>();

ipcRenderer.on(
  RunnerHostEvent.deviceFlowResult,
  (_event: unknown, payload: unknown): void => {
    const envelope = payload as DeviceFlowResultEnvelope;
    const handler = resultHandlers.get(envelope.attemptId);
    if (handler !== undefined) {
      resultHandlers.delete(envelope.attemptId);
      handler(envelope.result);
      return;
    }
    cachedResults.set(envelope.attemptId, envelope.result);
  },
);

export interface DeviceFlowSessionBridge {
  readonly authorization: DeviceFlowAuthorization;
  onResult(handler: Listener<DeviceFlowResult>): Disposable;
  pollNow(): void;
  cancel(): void;
}

export interface DeviceFlowBridgeSurface {
  start(): Promise<DeviceFlowSessionBridge | null>;
}

export function buildDeviceFlowBridge(): DeviceFlowBridgeSurface {
  return {
    start: async (): Promise<DeviceFlowSessionBridge | null> => {
      const response = (await ipcRenderer.invoke(
        RunnerHostInvoke.deviceFlowStart,
      )) as DeviceFlowStartResponse;
      if (
        !response.ok ||
        response.attemptId === undefined ||
        response.authorization === undefined
      ) {
        return null;
      }
      const attemptId = response.attemptId;
      return {
        authorization: response.authorization,
        pollNow: () => {
          void ipcRenderer.invoke(
            RunnerHostInvoke.deviceFlowPollNow,
            attemptId,
          );
        },
        onResult: (handler) => {
          const cached = cachedResults.get(attemptId);
          if (cached !== undefined) {
            cachedResults.delete(attemptId);
            handler(cached);
            return { dispose: () => undefined };
          }
          resultHandlers.set(attemptId, handler);
          return {
            dispose: () => {
              if (resultHandlers.get(attemptId) === handler) {
                resultHandlers.delete(attemptId);
              }
            },
          };
        },
        cancel: () => {
          resultHandlers.delete(attemptId);
          cachedResults.delete(attemptId);
          void ipcRenderer.invoke(
            RunnerHostInvoke.deviceFlowCancel,
            attemptId,
          );
        },
      };
    },
  };
}
