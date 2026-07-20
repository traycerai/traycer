import { log } from "./logger";
import { isHostRemovedByUser } from "../host/host-removal-state";
import {
  hostManagesHostLoginItem,
  readHostLoginItemStatus,
  registerHostLoginItem,
  type HostLoginItemStatus,
} from "./host-login-item";
import {
  HOST_READY_POLL_MS,
  HOST_READY_TIMEOUT_MS,
  waitForHostReady,
} from "../host/host-readiness";
import type { IpcHostLifecycle } from "../ipc/runner-ipc-bridge";

// Single user-visible message for the SMAppService approval state.
// Defined here so both the ensure-IPC and the respawn-IPC share it and
// the menu/tray paths can consume it without an inverted dependency on
// `ipc/host-ensure-ipc.ts`.
//
// Exported so all callers (ensure path, IPC respawn, menu/tray respawn)
// render the same actionable copy.
export function approvalRequiredMessage(): string {
  return (
    "Traycer's background host is registered but disabled by macOS. " +
    "Open System Settings → General → Login Items & Extensions and turn on " +
    'Traycer under "Allow in the Background", then click Retry.'
  );
}

/**
 * Single in-flight respawn promise, shared across every entry point -
 * IPC `requestHostRespawn`, tray "Restart Host", menu-bar host
 * actions. Two concurrent invocations would interleave SMAppService
 * unregister/register cycles and produce the very same LWCR-stuck state
 * the fix exists to prevent. This remains a respawn-specific dedup; the
 * shared lock in `host-login-item.ts` also serializes this flow with ensure
 * and pending-revision refresh cycles.
 */
let inFlight: Promise<void> | null = null;

/**
 * The single respawn entrypoint. Routes:
 *
 * - On macOS shipped builds with the in-bundle LaunchAgent plist
 *   (`hostManagesHostLoginItem()` returns true), drive the
 *   SMAppService unregister→register cycle. Bypasses the CLI's
 *   `traycer host restart` (launchctl kickstart) path, which cannot
 *   refresh BTM's cached LWCR and therefore fails for the exact same
 *   reason the initial spawn does. See `host-login-item.ts:
 *   registerHostLoginItem` for the LWCR rationale.
 *
 * - Everywhere else (non-darwin, dev slot, builds without the
 *   in-bundle plist), delegate to `HostLifecycle.respawn()` which
 *   shells to `traycer host restart`.
 *
 * Throws on hard failures (approval required, register refused,
 * readiness timeout) so callers can decide whether to surface the
 * error. The mutex ensures only one respawn runs at a time across all
 * entry points.
 */
export async function respawnHost(host: IpcHostLifecycle): Promise<void> {
  // The user removed Traycer's background components on this device. Don't let
  // a tray/menu "Restart Host" resurrect it; the host stays gone until an
  // explicit reinstall clears the sentinel.
  if (await isHostRemovedByUser()) {
    log.info("[host-respawn] skipped - host removed by user");
    return;
  }
  if (inFlight !== null) {
    return inFlight;
  }
  const run = doRespawn(host);
  inFlight = run;
  try {
    await run;
  } finally {
    inFlight = null;
  }
}

async function doRespawn(host: IpcHostLifecycle): Promise<void> {
  const hostOwnsLoginItem = await hostManagesHostLoginItem();
  if (hostOwnsLoginItem) {
    await respawnViaLoginItem(host);
    return;
  }
  await host.respawn();
}

async function respawnViaLoginItem(host: IpcHostLifecycle): Promise<void> {
  if (host.isDisposed) return;
  log.info("[host-respawn] cycling SMAppService registration");

  // Capture the pre-respawn pid so the readiness poll can skip the
  // still-bound old host during the brief window between
  // SMAppService.unregister and launchd's actual unload. Without this,
  // a fast poll would treat the old host's pid.json as "ready" and
  // return before the LWCR refresh has actually replaced the process.
  const preStatus = await host.getServiceStatus();
  const prePid = preStatus.state === "running" ? preStatus.pid : null;

  // Clear the renderer's host snapshot so the loading state shows
  // immediately. The pid-file watcher will re-fill it when the cycled
  // host publishes pid.json under its fresh LWCR; we also force a
  // reload below as defense-in-depth against fs.watch coalescing.
  host.notifyRespawning();

  if (host.isDisposed) return;
  // No revalidation guard: a respawn is a deliberate teardown+re-register,
  // not an opportunistic idle-only refresh, so it intentionally proceeds
  // regardless of host activity.
  const status = await registerHostLoginItem(undefined);
  if (host.isDisposed) return;
  if (status === "removed-by-user") {
    // "Remove Traycer" ran while this respawn waited on the registration
    // lock; the locked cycle refused to resurrect the login item. Mirror
    // the entry check's silent skip.
    log.info("[host-respawn] skipped - host removed by user mid-respawn");
    return;
  }
  if (status === "requires-approval") {
    throw new Error(approvalRequiredMessage());
  }
  if (status === "deferred-busy") {
    // Unreachable: this call site passes no revalidation guard (see above),
    // so `registerHostLoginItemUnserialized` never produces this outcome.
    throw new Error(
      "[host-respawn] registerHostLoginItem reported deferred-busy without a revalidation guard",
    );
  }
  if (status !== "enabled") {
    log.warn(
      "[host-respawn] SMAppService did not enable the agent after cycle",
      { status },
    );
    throw new Error(notEnabledMessage(status));
  }

  const readiness = await waitForHostReady(
    HOST_READY_TIMEOUT_MS,
    host.pidMetadataFile,
    HOST_READY_POLL_MS,
    prePid,
  );
  if (host.isDisposed) return;
  if (!readiness.ready) {
    // Mirror the ensure path's enrichment: macOS can flip the agent to
    // `requires-approval` mid-wait (user toggled the switch in System
    // Settings during the poll), and that's indistinguishable from a
    // generic readiness timeout without a fresh status check.
    const postWaitStatus = readHostLoginItemStatus();
    log.warn("[host-respawn] host did not become reachable after re-register", {
      reason: readiness.reason,
      loginItemStatus: postWaitStatus,
    });
    if (postWaitStatus === "requires-approval") {
      throw new Error(approvalRequiredMessage());
    }
    throw new Error(
      `The host did not become reachable after restart (${readiness.reason}). Open Doctor or run 'traycer host doctor' to recover.`,
    );
  }

  // Refresh the renderer's snapshot directly rather than relying on
  // fs.watch firing. FSEvents coalescing on macOS occasionally drops
  // the create event after a quick pid.json replacement, which would
  // otherwise leave `currentSnapshot === null` forever even though the
  // host is healthy. Also re-arm the watcher in case an earlier
  // FSEvents stream reset silently tore it down.
  host.ensureWatcherInstalled();
  await host.reloadSnapshotFromDisk();

  log.info("[host-respawn] host reachable after re-register", {
    version: readiness.version,
    pid: readiness.pid,
  });
}

function notEnabledMessage(status: HostLoginItemStatus): string {
  return `The host's macOS login item could not be enabled (status: ${status}). Open Doctor or run 'traycer host doctor' to recover.`;
}
