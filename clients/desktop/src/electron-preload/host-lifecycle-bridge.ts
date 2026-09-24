import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../ipc-contracts/ipc-channels";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
  LocalHostCapability,
} from "../ipc-contracts/host-lifecycle-types";
import type {
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
} from "../ipc-contracts/host-quit-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";
import { readSyncString } from "./sync-bootstrap";

/**
 * `runnerHost.hostLifecycle`: the host lifecycle mode, as main reads it from
 * the policy file on every call. Present in every app instance - including
 * one booted in `none` mode, where it is the only way back.
 *
 * The three quit members are the quit transaction's round-trip with the host
 * quit modal (see `host-quit-types.ts`).
 */
export interface HostLifecycleBridgeSurface {
  get(): Promise<HostLifecycleView>;
  set(request: HostLifecycleSetRequest): Promise<HostLifecycleSetResult>;
  onChange(handler: Listener<HostLifecycleView>): Disposable;
  onQuitRequest(
    handler: (request: HostQuitDecisionRequest) => void,
  ): Disposable;
  respondToQuitRequest(response: HostQuitDecisionResponse): Promise<void>;
  onQuitState(handler: (event: HostQuitStateEvent) => void): Disposable;
}

export function buildHostLifecycleBridge(): HostLifecycleBridgeSurface {
  return {
    get: () => ipcRenderer.invoke(RunnerHostInvoke.hostLifecycleGet),
    set: (request) =>
      ipcRenderer.invoke(RunnerHostInvoke.hostLifecycleSet, request),
    onChange: (handler) =>
      subscribe<HostLifecycleView>(
        RunnerHostEvent.hostLifecycleChange,
        handler,
      ),
    onQuitRequest: buildQuitRequestSubscriber(),
    respondToQuitRequest: (response) =>
      ipcRenderer.invoke(RunnerHostInvoke.hostQuitRespond, response),
    onQuitState: (handler) =>
      subscribe<HostQuitStateEvent>(RunnerHostEvent.hostQuitState, handler),
  };
}

/**
 * `onQuitRequest`, plus the two things main needs and the renderer surface
 * deliberately does not carry:
 *
 * - READINESS: main only sends a quit request to a window that is listening,
 *   so the first subscriber in this window reports `listening: true` and the
 *   last dispose reports `false`. A window that never mounted the modal (the
 *   sign-in route, a readiness gate) gets the native dialog instead of a
 *   request nobody answers.
 * - SERVICING ACK: once a request reached a handler that returned without
 *   throwing, the preload acknowledges its `requestId`. That proves the
 *   renderer thread is alive and a listener ran; a frozen renderer never acks,
 *   and main falls back to the native dialog within its budget.
 *
 * Refcounted per preload realm, i.e. per window: a reload starts a new realm,
 * and main forgets the window's readiness when its renderer resets.
 */
function buildQuitRequestSubscriber(): (
  handler: (request: HostQuitDecisionRequest) => void,
) => Disposable {
  let subscribers = 0;
  const reportListening = (listening: boolean): void => {
    void ipcRenderer
      .invoke(RunnerHostInvoke.hostQuitListening, listening)
      .catch(() => undefined);
  };
  return (handler) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const request = payload as HostQuitDecisionRequest;
      // A throwing handler skips the ack on purpose: main then treats this
      // window as unable to service the request and asks natively.
      handler(request);
      void ipcRenderer
        .invoke(RunnerHostInvoke.hostQuitAcknowledge, request.requestId)
        .catch(() => undefined);
    };
    ipcRenderer.on(RunnerHostEvent.hostQuitRequest, wrapped);
    subscribers += 1;
    if (subscribers === 1) reportListening(true);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ipcRenderer.removeListener(RunnerHostEvent.hostQuitRequest, wrapped);
        subscribers -= 1;
        if (subscribers === 0) reportListening(false);
      },
    };
  };
}

/**
 * Whether this app instance runs the local-host lanes, pinned by main at boot.
 * Read synchronously at preload load so the renderer knows before any host
 * code runs. Fail-safe: an unanswered, unrecognised or THROWING read keeps
 * today's behaviour (`managed`), because this runs inside the preload's boot
 * object and a throw there would leave the renderer with no `runnerHost` at
 * all.
 */
export function readLocalHostCapability(): LocalHostCapability {
  let value: string;
  try {
    value = readSyncString(RunnerHostSync.localHostCapability, "managed");
  } catch {
    return "managed";
  }
  return value === "none" ? "none" : "managed";
}
