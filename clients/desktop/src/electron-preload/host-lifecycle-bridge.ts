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
import { subscribe, type Disposable, type Listener } from "./subscribe";
import { readSyncString } from "./sync-bootstrap";

/**
 * `runnerHost.hostLifecycle`: the host lifecycle mode, as main reads it from
 * the policy file on every call. Present in every app instance - including
 * one booted in `none` mode, where it is the only way back.
 */
export interface HostLifecycleBridgeSurface {
  get(): Promise<HostLifecycleView>;
  set(request: HostLifecycleSetRequest): Promise<HostLifecycleSetResult>;
  onChange(handler: Listener<HostLifecycleView>): Disposable;
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
