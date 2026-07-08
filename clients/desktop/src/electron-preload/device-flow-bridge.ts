import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DeviceFlowAuthorization,
  DeviceFlowResult,
} from "../ipc-contracts/device-flow-types";
import type { Disposable, Listener } from "./subscribe";

interface DeviceFlowResultEnvelope {
  readonly attemptId: string;
  readonly result: DeviceFlowResult;
}

/**
 * Narrowed `deviceFlowStart` reply for a successfully started attempt. `ok:
 * false` (or any malformed reply) collapses an authorize failure (network/5xx)
 * into a `null` session for the renderer.
 */
interface StartedDeviceFlowResponse {
  readonly ok: true;
  readonly attemptId: string;
  readonly authorization: DeviceFlowAuthorization;
}

const DEVICE_FLOW_RESULT_KINDS = new Set<string>([
  "authorized",
  "denied",
  "expired",
  "error",
]);

function isDeviceFlowAuthorization(
  value: unknown,
): value is DeviceFlowAuthorization {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.userCode === "string" &&
    typeof record.verificationUri === "string" &&
    typeof record.verificationUriComplete === "string" &&
    typeof record.expiresInSeconds === "number" &&
    typeof record.intervalSeconds === "number"
  );
}

function isDeviceFlowResult(value: unknown): value is DeviceFlowResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== "string" ||
    !DEVICE_FLOW_RESULT_KINDS.has(record.kind)
  ) {
    return false;
  }
  if (record.kind === "authorized") {
    return (
      typeof record.token === "string" &&
      typeof record.refreshToken === "string"
    );
  }
  return true;
}

function isDeviceFlowResultEnvelope(
  value: unknown,
): value is DeviceFlowResultEnvelope {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.attemptId === "string" && isDeviceFlowResult(record.result)
  );
}

function isStartedDeviceFlowResponse(
  value: unknown,
): value is StartedDeviceFlowResponse {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    typeof record.attemptId === "string" &&
    isDeviceFlowAuthorization(record.authorization)
  );
}

/**
 * Per-attempt terminal-result routing. The main-process loop can settle before
 * the renderer subscribes (or the event can race the `start()` response), so a
 * result that arrives without a live handler is cached by `attemptId` and
 * replayed on the next `onResult`. Mirrors the cold-start replay cache in
 * `auth-bridge.ts`. Each `attemptId` settles exactly once, so an entry is
 * consumed-and-dropped on delivery and never accumulates.
 *
 * A `Set` of listeners per `attemptId` keeps every subscriber: a second
 * `onResult` must NOT silently replace the first, or only the last subscriber
 * could observe the terminal result.
 */
const resultHandlers = new Map<string, Set<Listener<DeviceFlowResult>>>();
const cachedResults = new Map<string, DeviceFlowResult>();

ipcRenderer.on(
  RunnerHostEvent.deviceFlowResult,
  (_event: unknown, payload: unknown): void => {
    // The payload crosses an IPC boundary as `unknown`; a null or shape-drifted
    // event must be dropped rather than throw inside preload (which would break
    // sign-in for every attempt, not just this event).
    if (!isDeviceFlowResultEnvelope(payload)) {
      return;
    }
    const handlers = resultHandlers.get(payload.attemptId);
    if (handlers !== undefined && handlers.size > 0) {
      resultHandlers.delete(payload.attemptId);
      for (const handler of handlers) {
        handler(payload.result);
      }
      return;
    }
    cachedResults.set(payload.attemptId, payload.result);
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
      // The invoke can reject if the main handler throws or the channel is gone
      // during shutdown; this preload boundary collapses that to a failed start
      // (`null`) to honor the `DeviceFlowSession | null` contract instead of
      // rejecting `start()`.
      let response: unknown;
      try {
        response = await ipcRenderer.invoke(RunnerHostInvoke.deviceFlowStart);
      } catch {
        return null;
      }
      // Validate the reply shape before dereferencing: a null / shape-drifted
      // reply is treated as a failed start (null) rather than throwing here.
      if (!isStartedDeviceFlowResponse(response)) {
        return null;
      }
      const attemptId = response.attemptId;
      return {
        authorization: response.authorization,
        pollNow: () => {
          // Best-effort nudge: a rejection (handler threw, or the channel is
          // gone during shutdown) must not become an unhandled rejection.
          void ipcRenderer
            .invoke(RunnerHostInvoke.deviceFlowPollNow, attemptId)
            .catch(() => undefined);
        },
        onResult: (handler) => {
          const cached = cachedResults.get(attemptId);
          if (cached !== undefined) {
            cachedResults.delete(attemptId);
            handler(cached);
            return { dispose: () => undefined };
          }
          const handlers = resultHandlers.get(attemptId) ?? new Set();
          handlers.add(handler);
          resultHandlers.set(attemptId, handlers);
          return {
            dispose: () => {
              const live = resultHandlers.get(attemptId);
              if (live === undefined) {
                return;
              }
              live.delete(handler);
              if (live.size === 0) {
                resultHandlers.delete(attemptId);
              }
            },
          };
        },
        cancel: () => {
          resultHandlers.delete(attemptId);
          cachedResults.delete(attemptId);
          // Best-effort cancel: swallow a rejected invoke for the same reason
          // as `pollNow`.
          void ipcRenderer
            .invoke(RunnerHostInvoke.deviceFlowCancel, attemptId)
            .catch(() => undefined);
        },
      };
    },
  };
}
