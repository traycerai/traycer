import { log } from "../app/logger";
import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import type {
  HostControllerStatus,
  MutationLaneStatus,
} from "../host/host-controller-types";
import type { IpcHostController } from "./runner-ipc-bridge";

// The download lane has no live push observer on `HostController` (by
// design - `runDownloadLane` only mutates `this.downloadStatus` in place;
// see its cleanup-path comment anticipating this ticket). Poll tightly only
// while a download is actually in flight; a low-frequency idle floor
// catches any other externally-driven transition (e.g. a `stageLatest()`
// kicked off by the launch converge reconcile before any window subscribed).
const ACTIVE_DOWNLOAD_POLL_MS = 750;
const IDLE_POLL_MS = 5_000;

type MutationStatusObserver = {
  onMutationStatus(
    listener: (status: MutationLaneStatus | null) => void,
  ): () => void;
};

function hasMutationStatus(
  hostController: IpcHostController,
): hostController is IpcHostController & MutationStatusObserver {
  return "onMutationStatus" in hostController;
}

type StatusListener = (status: HostControllerStatus) => void;

// Structural surface of `RunnerIpcBridge` this module depends on - declared
// here (like `IpcHostController` itself) so tests can pass a lightweight
// double instead of constructing the real class, whose private members make
// it unsatisfiable structurally.
export interface HostControllerStatusBroadcastBridge {
  readonly options: { readonly hostController: IpcHostController };
  readonly disposeFns: Array<() => void>;
  fanOut(channel: string, payload: unknown): void;
}

// Extra in-process listeners keyed by bridge instance, so main-process code
// outside the IPC layer (the app-menu "Update to X" gating in
// `desktop-startup.ts`) can react to the same broadcast ticks that already
// drive the renderer push, instead of standing up a second poll loop.
const extraListeners = new WeakMap<
  HostControllerStatusBroadcastBridge,
  Set<StatusListener>
>();

/**
 * Subscribes to every status tick this module already computes (mutation
 * push + download-lane poll). Returns an unsubscribe function. Safe to call
 * before or after `registerHostControllerStatusBroadcast` - the listener
 * set is created lazily.
 */
export function onHostControllerStatusBroadcast(
  bridge: HostControllerStatusBroadcastBridge,
  listener: StatusListener,
): () => void {
  let listeners = extraListeners.get(bridge);
  if (listeners === undefined) {
    listeners = new Set();
    extraListeners.set(bridge, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}

/**
 * Broadcasts the canonical two-lane `HostControllerStatus` (Host Update
 * Layer Redesign Tech Plan) to every renderer window on
 * `RunnerHostEvent.hostControllerStatusChange`. The mutation lane pushes
 * immediately via `HostController`'s own observers
 * (`onMutationProgress`/`onMutationStatus`); the download lane is polled
 * (see interval rationale above). Returns a disposer, wired into
 * `bridge.disposeFns` by the caller like every other subscription in this
 * module.
 */
export function registerHostControllerStatusBroadcast(
  bridge: HostControllerStatusBroadcastBridge,
): void {
  const hostController = bridge.options.hostController;
  let activeTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let broadcastInFlight = false;
  let broadcastRequested = false;

  const stopActivePolling = (): void => {
    if (activeTimer === null) return;
    clearInterval(activeTimer);
    activeTimer = null;
  };

  const ensureActivePolling = (): void => {
    if (activeTimer !== null || disposed) return;
    activeTimer = setInterval(() => {
      void broadcast();
    }, ACTIVE_DOWNLOAD_POLL_MS);
  };

  const publish = async (): Promise<void> => {
    const status = await hostController.getStatus();
    if (disposed) return;
    try {
      bridge.fanOut(RunnerHostEvent.hostControllerStatusChange, status);
    } catch (err) {
      // Isolated like the listener loop below so a dispatch failure (e.g. a
      // window destroyed mid-send) is never mistaken for an unhealthy
      // controller - the status read succeeded and polling cadence decisions
      // below still deserve to run on it.
      log.warn("[host-controller-status-broadcast] fanOut threw", { err });
    }
    for (const listener of extraListeners.get(bridge) ?? []) {
      try {
        listener(status);
      } catch (err) {
        log.warn("[host-controller-status-broadcast] listener threw", {
          err,
        });
      }
    }
    if (status.download !== null && status.download.lastError === null) {
      ensureActivePolling();
    } else {
      stopActivePolling();
    }
  };

  // One `broadcast` fires per mutation-progress event, and a host install
  // streams thousands of them while it downloads. `getStatus()` is not cheap
  // (three JSON reads plus a TCP reachability probe), so letting those calls
  // overlap buried libuv's four-thread pool under thousands of concurrent fs
  // operations and starved the main process event loop - the "Traycer is not
  // responding" dialogs seen while installing.
  //
  // Serializing collapses a burst into the only status the renderer actually
  // needs: whatever holds once the burst settles. The trailing re-run keeps
  // the last event from being the one dropped. Ordering is structural now,
  // so the publication-generation counters this used to carry are gone -
  // nothing can arrive out of order when only one read is ever in flight.
  //
  // A failed read costs only its own publication: the drain loop keeps going,
  // so a tick queued behind the failure (which may carry the mutation's
  // terminal status) still gets its re-read instead of waiting out the idle
  // interval with the renderer stuck on a stale "active" status.
  const broadcast = async (): Promise<void> => {
    if (disposed) return;
    if (broadcastInFlight) {
      broadcastRequested = true;
      return;
    }
    broadcastInFlight = true;
    try {
      do {
        broadcastRequested = false;
        try {
          await publish();
        } catch (err) {
          log.warn("[host-controller-status-broadcast] getStatus failed", {
            err,
          });
          // Degrade to the idle floor while the controller is unhealthy - a
          // repeatedly-throwing getStatus must not keep the tight download
          // cadence (and its per-tick warn) alive indefinitely.
          stopActivePolling();
        }
      } while (broadcastRequested && !disposed);
    } finally {
      broadcastInFlight = false;
    }
  };

  const idleTimer = setInterval(() => {
    void broadcast();
  }, IDLE_POLL_MS);

  bridge.disposeFns.push(
    hostController.onMutationProgress(() => {
      void broadcast();
    }),
  );
  if (hasMutationStatus(hostController)) {
    bridge.disposeFns.push(
      hostController.onMutationStatus(() => {
        void broadcast();
      }),
    );
  }
  bridge.disposeFns.push(() => {
    disposed = true;
    stopActivePolling();
    clearInterval(idleTimer);
    extraListeners.delete(bridge);
  });
}
