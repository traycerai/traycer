import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type { DesktopPublishedHostSnapshot } from "../ipc-contracts/host-types";
import type { HostRestartRequestResult } from "../ipc-contracts/host-management-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

/**
 * Eagerly subscribe at module load so the initial host snapshot pushed
 * during `RunnerIpcBridge.install()` is captured even if the renderer
 * constructs its `DesktopRunnerHost` after that push. New subscribers receive
 * the cached value synchronously and every subsequent transition via fan-out.
 */
let cachedLocalHost: DesktopPublishedHostSnapshot | null = null;
/**
 * Bumped on every PUSH. The pull below carries the value it saw before its
 * `invoke`, so a push that lands while the round trip is in flight always
 * wins - the pull is a floor, never an overwrite.
 */
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

/**
 * Ask main for the snapshot rather than waiting to be told.
 *
 * `cachedLocalHost` starts at `null`, and `null` is not "unknown" downstream -
 * it is the renderer's ONLY way of saying "this machine has no host", which the
 * directory turns into an explicitly unavailable row and every chat owned by
 * that host turns into a read-only published copy. So any delivery hazard on
 * the push channel does not degrade, it LIES, and it lies in the direction that
 * costs the user their session: a window that registered after the install-time
 * fan-out, a `webContents` reload that resets this module's cache, a send
 * dropped while the renderer was navigating. None of them self-correct on a
 * steady-state host, because the correction was going to be a `change` event
 * and nothing is changing.
 *
 * One invoke on first subscribe closes all of them at once. It runs exactly
 * once per preload instance - so it also covers ⌘R, which re-executes this
 * module - and it defers to any push that arrives while it is in flight.
 */
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
      // A main process that cannot answer leaves the push channel exactly as
      // it was; this is a repair path, not a dependency. But a failed attempt
      // must not consume the once-per-preload slot: with the flag left set, a
      // boot-time rejection would freeze `cachedLocalHost` at `null` - which
      // downstream reads as "this machine has no host", not "unknown" - until
      // a `change` event a steady-state host will never send. Clearing it lets
      // the next subscriber run the repair again.
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
  onSystemResumed(handler: () => void): Disposable;
  requestHostRespawn(): Promise<HostRestartRequestResult>;
  getLastKnownLocalHostId(): Promise<string | null>;
  hostPicker: {
    requestOpen(): Promise<void>;
    requestClose(): Promise<void>;
    onChange(handler: Listener<boolean>): Disposable;
  };
}

export function buildHostBridge(): HostBridgeSurface {
  return {
    onLocalHostChange: (handler) => subscribeLocalHost(handler),

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

    hostPicker: {
      requestOpen: () =>
        ipcRenderer.invoke(RunnerHostInvoke.hostPickerRequestOpen),
      requestClose: () =>
        ipcRenderer.invoke(RunnerHostInvoke.hostPickerRequestClose),
      onChange: (handler) =>
        subscribe<boolean>(RunnerHostEvent.hostPickerChange, handler),
    },
  };
}
