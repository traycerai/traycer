import { randomUUID } from "node:crypto";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import { log } from "../app/logger";
import {
  refreshRegistryUpdateState,
  streamCliWithProgress,
} from "../ipc/host-management-ipc";
import type { RunnerIpcBridge } from "../ipc/runner-ipc-bridge";
import type { HostRegistryUpdateState } from "../../ipc-contracts/host-management-types";
import type { HostLifecycle } from "./host-lifecycle";

// Coordinated host auto-update (Flow 6 follow-up). The host provisions
// independently of the desktop shell, so a desktop self-update leaves the host
// on its old version. This reconciler bridges the two: when a host update is
// available and the host is idle, it runs `traycer host update` so the host
// tracks the app. It runs in two places:
//
//   - On launch (deferred boot phase): the relaunch after a desktop self-update
//     lands here, so "the host updates with the desktop app" holds.
//   - At quit-to-install time: a best-effort attempt before the desktop swaps
//     its own bytes, with the launch reconcile as the guaranteed fallback when
//     the quit-time attempt is skipped (host busy) or fails.
//
// It is strictly idle-gated and fail-open: an indeterminate busy state, an
// unreachable registry, or a failed update never blocks the desktop and never
// tears down in-progress work - the next launch retries.

// A host swap is download + signature-verify + atomic rename; seconds in
// practice. The launch path can wait the full window since it runs in the
// background; the quit path uses a tighter cap so "Restart to install" never
// hangs on a slow download (the CLI runner SIGKILLs the child on timeout, and
// installHost stages to a temp dir before the atomic swap, so a timeout during
// download never leaves a half-installed host).
export const LAUNCH_HOST_UPDATE_TIMEOUT_MS = 5 * 60_000;
export const QUIT_HOST_UPDATE_TIMEOUT_MS = 2 * 60_000;

export type HostAutoUpdateOutcome =
  "updated" | "up-to-date" | "skipped-busy" | "failed";

export interface HostAutoUpdateDeps {
  // Current host update availability (force:false - the launch probe / 24h
  // cache already holds it; a cache read is cheap).
  readonly checkUpdateState: () => Promise<HostRegistryUpdateState>;
  // Awaited before the idle gate so `getHostWebsocketUrl()` reflects a settled
  // host discovery. This is load-bearing: at boot the host snapshot starts
  // null and is populated by an async, concurrent `HostLifecycle.bootstrap()`,
  // so reading it too early would mistake a still-running host for a stopped
  // one and stop it mid-work. After this resolves, a null url provably means
  // the host is not running (nothing to protect). Resolve immediately when the
  // host is already discovered (the quit-to-install path).
  readonly awaitHostReady: () => Promise<void>;
  // Loopback RPC URL of the running host, or null when it isn't running. Only
  // read after `awaitHostReady()` resolves, so null is a trustworthy
  // "not running" (and thus idle) signal rather than "not loaded yet".
  readonly getHostWebsocketUrl: () => string | null;
  // `true` when the host reports work in progress or its state can't be
  // determined (fail-safe busy).
  readonly probeBusy: (websocketUrl: string) => Promise<boolean>;
  // Runs the actual `traycer host update`.
  readonly runHostUpdate: () => Promise<void>;
  // Re-probes the registry with force after a successful update so the cached
  // installedVersion (and the Updates row / banner / menu) reflect the swap.
  readonly refreshAfter: () => Promise<void>;
}

/**
 * Idle-gated host update. Pure decision + action over injected collaborators
 * so it unit-tests without spawning the CLI or touching Electron. Never
 * throws: a failed update is reported as `"failed"`, not propagated.
 */
export async function reconcileHostAutoUpdate(
  reason: string,
  deps: HostAutoUpdateDeps,
): Promise<HostAutoUpdateOutcome> {
  const state = await deps.checkUpdateState();
  if (
    !state.reachable ||
    !state.updateAvailable ||
    state.latestVersion === null
  ) {
    return "up-to-date";
  }

  // Let host discovery settle before trusting the snapshot - otherwise a null
  // url at boot (snapshot not loaded yet) would fail the idle gate open and
  // stop a host that is actually running work.
  await deps.awaitHostReady();
  const websocketUrl = deps.getHostWebsocketUrl();
  if (websocketUrl !== null) {
    const busy = await deps.probeBusy(websocketUrl);
    if (busy) {
      log.info("[host-auto-update] host busy - deferring update", {
        reason,
        latestVersion: state.latestVersion,
      });
      return "skipped-busy";
    }
  }

  log.info("[host-auto-update] updating idle host", {
    reason,
    installedVersion: state.installedVersion,
    latestVersion: state.latestVersion,
  });
  try {
    await deps.runHostUpdate();
  } catch (err) {
    log.warn("[host-auto-update] host update failed - will retry next launch", {
      reason,
      err,
    });
    return "failed";
  }
  await deps.refreshAfter();
  log.info("[host-auto-update] host updated", {
    reason,
    latestVersion: state.latestVersion,
  });
  return "updated";
}

/**
 * Wires {@link reconcileHostAutoUpdate} to the real registry cache, host
 * snapshot, activity probe, and CLI. `timeoutMs` bounds the `host update`
 * subprocess (the CLI runner SIGKILLs it on timeout).
 *
 * `runHostUpdate` goes through the same `streamCliWithProgress` seam the
 * renderer-triggered install/update/register-service/ensure handlers use
 * (Ticket: host-update-race-conditions) - a background-triggered update is
 * otherwise invisible to every open window, so a manual click during a
 * launch/quit-time coordinated update would spawn a second `traycer host
 * update` and lose the race on the CLI's file lock. Routing through the
 * shared single-flight guard instead makes the background update visible
 * (buttons disable, progress shows) and makes a concurrent manual click a
 * same-process no-op instead of a `CLI_LOCK_BUSY` error.
 */
export function defaultHostAutoUpdateDeps(
  host: HostLifecycle,
  timeoutMs: number,
  awaitHostReady: () => Promise<void>,
  bridge: RunnerIpcBridge,
): HostAutoUpdateDeps {
  return {
    checkUpdateState: () =>
      refreshRegistryUpdateState({ force: false, maxAgeMs: null }),
    awaitHostReady,
    getHostWebsocketUrl: () => host.getSnapshot()?.websocketUrl ?? null,
    probeBusy: probeHostActivityBusy,
    runHostUpdate: async () => {
      await streamCliWithProgress(
        ["host", "update"],
        randomUUID(),
        "update",
        timeoutMs,
        bridge,
      );
    },
    refreshAfter: async () => {
      await refreshRegistryUpdateState({ force: true, maxAgeMs: null });
    },
  };
}
