import { log } from "../app/logger";
import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import type {
  HostControllerStatus,
  MutationLaneStatus,
} from "../host/host-controller-types";
import type { IpcHostController } from "./runner-ipc-bridge";

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

export interface HostControllerStatusBroadcastBridge {
  readonly options: { readonly hostController: IpcHostController };
  readonly disposeFns: Array<() => void>;
  fanOut(channel: string, payload: unknown): void;
}

const extraListeners = new WeakMap<
  HostControllerStatusBroadcastBridge,
  Set<StatusListener>
>();

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

/** Returns a disposer, wired into `bridge.disposeFns` by the caller like every other subscription in this module. */
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
      // Isolated like the listener loop below so a dispatch failure (e.g. a window destroyed mid-send) is never mistaken for an unhealthy controller.
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
