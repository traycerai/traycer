import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DesktopPublishedHostSnapshot,
  RegisteredHostsPush,
} from "../ipc-contracts/host-types";
import type { HostRestartRequestResult } from "../ipc-contracts/host-management-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/** New subscribers receive the cached value synchronously and every subsequent transition via fan-out. */
let cachedLocalHost: DesktopPublishedHostSnapshot | null = null;
/** The pull below carries the value it saw before its `invoke`, so a push that lands while the round trip is in flight always wins - the pull is a floor, never an overwrite. */
let localHostPushGeneration = 0;
let localHostPullStarted = false;
const localHostHandlers = new Set<
  Listener<DesktopPublishedHostSnapshot | null>
>();

ipcRenderer.on(
  RunnerHostEvent.localHostChange,
  (_event: unknown, payload: unknown): void => {
    const snapshot = payload as DesktopPublishedHostSnapshot | null;
    localHostPushGeneration += 1;
    cachedLocalHost = snapshot;
    for (const handler of localHostHandlers) {
      handler(snapshot);
    }
  },
);

function pullLocalHostOnce(): void {
  if (localHostPullStarted) return;
  localHostPullStarted = true;
  const generationAtRequest = localHostPushGeneration;
  void (
    ipcRenderer.invoke(RunnerHostInvoke.localHostSnapshot) as Promise<unknown>
  )
    .then((payload: unknown) => {
      if (localHostPushGeneration !== generationAtRequest) return;
      const snapshot = payload as DesktopPublishedHostSnapshot | null;
      if (snapshot === null && cachedLocalHost === null) return;
      cachedLocalHost = snapshot;
      for (const handler of localHostHandlers) {
        handler(snapshot);
      }
    })
    .catch(() => {
      // A main process that cannot answer leaves the push channel exactly as it was; this is a repair path, not a dependency.
      // But a failed attempt must not consume the once-per-preload slot: with the flag left set, a boot-time rejection would freeze `cachedLocalHost` at `null`.
      localHostPullStarted = false;
    });
}

function subscribeLocalHost(
  handler: Listener<DesktopPublishedHostSnapshot | null>,
): Disposable {
  localHostHandlers.add(handler);
  handler(cachedLocalHost);
  pullLocalHostOnce();
  return {
    dispose: () => {
      localHostHandlers.delete(handler);
    },
  };
}

export interface HostBridgeSurface {
  onLocalHostChange(
    handler: Listener<DesktopPublishedHostSnapshot | null>,
  ): Disposable;
  onRegisteredHostsChange(handler: Listener<RegisteredHostsPush>): Disposable;
  onSystemResumed(handler: () => void): Disposable;
  requestHostRespawn(): Promise<HostRestartRequestResult>;
  getLastKnownLocalHostId(): Promise<string | null>;
}

export function buildHostBridge(): HostBridgeSurface {
  return {
    onLocalHostChange: (handler) => subscribeLocalHost(handler),

    onRegisteredHostsChange: (handler) =>
      subscribe<RegisteredHostsPush>(
        RunnerHostEvent.registeredHostsChange,
        handler,
      ),

    // A transient "machine woke" pulse - no snapshot to cache, so it routes
    // through the generic per-event subscription (unlike the cached
    // local-host snapshot above).
    onSystemResumed: (handler) =>
      subscribe<void>(RunnerHostEvent.systemResumed, handler),

    requestHostRespawn: () =>
      ipcRenderer.invoke(
        RunnerHostInvoke.requestHostRespawn,
      ) as Promise<HostRestartRequestResult>,

    getLastKnownLocalHostId: () =>
      ipcRenderer.invoke(RunnerHostInvoke.lastKnownLocalHostId) as Promise<
        string | null
      >,
  };
}
