import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import type { RegisteredHostsPush } from "../../ipc-contracts/host-types";
import type { DesktopHostFleetSource } from "../selection/desktop-selection-ports";

const REGISTERED_HOSTS_POLL_MS = 60_000;

export interface RegisteredHostsBroadcastBridge {
  readonly disposeFns: Array<() => void>;
  fanOut(channel: string, payload: unknown): void;
}

export function createRegisteredHostsPublisher(
  bridge: RegisteredHostsBroadcastBridge,
): (push: RegisteredHostsPush) => void {
  return (push) => {
    bridge.fanOut(RunnerHostEvent.registeredHostsChange, push);
  };
}

/**
 * `DesktopHostFleetSource.refresh()` already captures the identity generation at fetch start, reads the bearer, drops a non-ok result without clobbering known membership, and is.
 * The cadence and disposal ARE pinned; `unref` is not, and this note is here so nobody reads three green arms as covering it.
 */
export function registerRegisteredHostsBroadcast(
  bridge: RegisteredHostsBroadcastBridge,
  fleet: DesktopHostFleetSource,
): void {
  const timer = setInterval(() => {
    void fleet.refresh();
  }, REGISTERED_HOSTS_POLL_MS);
  // The cadence must never be what keeps the main process alive.
  timer.unref();
  bridge.disposeFns.push(() => {
    clearInterval(timer);
  });
}
