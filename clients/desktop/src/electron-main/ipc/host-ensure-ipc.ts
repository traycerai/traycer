import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../app/logger";
import { resolveBundledCliPath } from "../cli/cli-discovery";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  getActiveEnvironment,
  LONG_OP_TIMEOUT_MS,
  optionalBoolean,
  optionalString,
  streamCliWithProgress,
} from "./host-management-ipc";
import { getHostFsLayout } from "../host/host-paths";
import type { Environment } from "../host/host-paths";
import { isHostRemovedByUser } from "../host/host-removal-state";
import {
  hasPendingLoginItemRevision,
  hostManagesHostLoginItem,
  readHostLoginItemStatus,
  registerHostLoginItem,
} from "../app/host-login-item";
import { approvalRequiredMessage } from "../app/host-respawn";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import { canReachHostWebsocketUrl } from "../host/host-lifecycle";
import {
  categorizeHostCliError,
  HOST_READY_POLL_MS,
  HOST_READY_TIMEOUT_MS,
  readServiceLifecycle,
  waitForHostReady,
  type HostEnsureResultPayload,
} from "../host/host-readiness";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

// Post-auth host provisioning (Core Flow: auth-first boot). The renderer
// invokes `traycerHostEnsure` once after sign-in when no host is
// reachable. The CLI owns host install + lifecycle (and all launchd
// interaction); the desktop's only OS-level step is registering the macOS
// login item via SMAppService (attribution), which the CLI cannot do. CLI
// progress is streamed back to the renderer on `cliOperationProgress`.
//
// Idempotent + deduped:
//   - fast path: if the host is already reachable, return without
//     spawning the CLI (the persistent service survives across launches).
//   - one in-flight ensure at a time: concurrent invokes (e.g. a transient
//     reconnect racing the first provision) share the same promise.

export interface HostEnsureIpcResult {
  readonly action: "already-ready" | "provisioned" | "host-busy" | "removed";
  readonly running: boolean;
  readonly version: string | null;
}

let inFlight: Promise<HostEnsureIpcResult> | null = null;
let inFlightForce = false;

export function registerHostEnsureIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostEnsure,
    async (_event, raw: unknown) => {
      const operationId = optionalString(raw, "operationId") ?? randomUUID();
      // The preload's `withOperationListener` spreads `{ force, operationId }`
      // into the invoke args; default false so a normal ensure keeps the busy
      // check.
      const force = optionalBoolean(raw, "force");
      return runEnsureHost(bridge, operationId, force);
    },
  );
}

/**
 * Coalesced entry point for `ensureHost`, factored out of the IPC handler so
 * a second caller can share the exact same in-flight slot: the pending-
 * LaunchAgent-revision monitor (`pending-login-item-revision-monitor.ts`)
 * invokes this too, rather than copying the `registerHostLoginItem` /
 * `waitForHostReady` sequence into its own unguarded call site. That keeps a
 * monitor-triggered SMAppService register cycle from ever running
 * concurrently with a renderer-triggered one - whichever caller gets here
 * first wins the slot; the other either shares its result (same `force`) or
 * waits for it to settle before starting its own. The registration helper
 * itself additionally serializes this ensure path with `respawnHost`.
 */
export async function runEnsureHost(
  bridge: RunnerIpcBridge,
  operationId: string,
  force: boolean,
): Promise<HostEnsureIpcResult> {
  // Coalesce only identical (same-force) concurrent ensures. A Force must
  // never be served by an in-flight non-force ensure (#6) - that would
  // silently drop `--force`. Wait for any different-force op to settle, then
  // run ours, so two installs never race. Re-check on every iteration (not
  // just once before the loop) so two same-force callers who both queue
  // behind a different-force in-flight op share ONE cycle instead of each
  // starting their own once the in-flight op settles.
  while (inFlight !== null) {
    if (inFlightForce === force) {
      return inFlight;
    }
    try {
      await inFlight;
    } catch {
      // The in-flight op's failure belongs to its own caller; re-evaluate.
    }
  }
  const run = ensureHost(bridge, operationId, force);
  inFlight = run;
  inFlightForce = force;
  try {
    return await run;
  } finally {
    if (inFlight === run) {
      inFlight = null;
    }
  }
}

async function ensureHost(
  bridge: RunnerIpcBridge,
  operationId: string,
  force: boolean,
): Promise<HostEnsureIpcResult> {
  const environment = getActiveEnvironment();

  // The user removed Traycer's background components on this device (Settings
  // → General → Danger Zone). Do NOT reinstall the host just because it is now
  // unreachable - that is precisely the auto-reinstall the removal exists to
  // stop. The renderer reads this `removed` action and shows the removed
  // surface instead; an explicit reinstall clears the sentinel first.
  if (await isHostRemovedByUser()) {
    log.info("[host-ensure] skipped - host removed by user");
    return { action: "removed", running: false, version: null };
  }

  // When this is a macOS .app build that ships the in-bundle LaunchAgent
  // plist, the desktop owns the macOS login-item registration via
  // SMAppService (the only path that yields a polished "Traycer" + icon
  // row attributed to the app). In that case the CLI installs the host
  // BYTES only (`--no-service-register`) and we register/start the login
  // item afterwards. Otherwise (non-macOS, or no in-bundle plist) the CLI
  // registers the service itself.
  const hostOwnsLoginItem = await hostManagesHostLoginItem();

  // Fast path - the persistent service is already up from a prior launch and
  // reachable. We do NOT gate on a build-stamp match: a host on a different
  // version may still be protocol-compatible, and the renderer negotiates that
  // over the WS handshake (prompting for a restart only if the running host is
  // genuinely incompatible). Serving a reachable host here is what lets an
  // updated host - or a newer CLI that provisioned it - keep working without a
  // forced reinstall/restart loop on every version difference. `prePid` lets
  // the readiness poll below skip the still-dying old host's pid.json during
  // the SMAppService unregister→register cycle.
  const serviceStatus = await bridge.options.host.getServiceStatus();
  const prePid = serviceStatus.state === "running" ? serviceStatus.pid : null;
  if (
    !force &&
    serviceStatus.state === "running" &&
    serviceStatus.listenUrl !== null
  ) {
    if (await canReachHostWebsocketUrl(serviceStatus.listenUrl)) {
      const refreshed = await applyPendingLoginItemRevisionIfIdle(
        environment,
        hostOwnsLoginItem,
        serviceStatus.listenUrl,
        prePid,
      );
      if (refreshed !== null) {
        return refreshed;
      }
      // Publish the reachable host into the lifecycle before returning.
      // This probe is private to the ensure flow - it does NOT update
      // `HostLifecycle.currentSnapshot` - and the watcher edge that should
      // have populated it may already be spent (edge-triggered on the
      // pid.json WRITE, while reachability is time-varying). Without this,
      // ensure can report success while the renderer's host directory stays
      // empty for the rest of the session (2026-07-14 incident).
      await bridge.options.host.reloadSnapshotFromDisk();
      return {
        action: "already-ready",
        running: true,
        version: serviceStatus.version,
      };
    }
    log.debug(
      "[host-ensure] service status file points at an unreachable endpoint - ensuring",
      { listenUrl: serviceStatus.listenUrl },
    );
  }

  // No `--environment` (the CLI resolves its slot from config.environment).
  //
  // Host source: on POSIX the per-user slot CLI is a symlink into the app
  // bundle, so `process.execPath` resolves beside the bundled host archive and
  // the CLI finds it itself - we pass nothing. On Windows symlinks need
  // privilege, so the slot CLI is a COPY outside the bundle; the CLI's
  // `resolveBundledHostArchive` can't see the sibling archive and would fall
  // back to the registry (which publishes no win32 asset for dogfood builds).
  // Point it at the bundled archive explicitly there.
  const bundledHostFrom = await resolveWindowsBundledHostArchive();

  const args = [
    "host",
    "ensure",
    ...(force ? ["--force"] : []),
    ...(hostOwnsLoginItem ? ["--no-service-register"] : []),
    ...(bundledHostFrom !== null ? ["--from", bundledHostFrom] : []),
  ];

  let payload: unknown;
  try {
    payload = await streamCliWithProgress(
      args,
      operationId,
      "ensure",
      LONG_OP_TIMEOUT_MS,
      bridge,
    );
  } catch (err) {
    const categorized = categorizeHostCliError(err);
    if (categorized.kind === "host-busy" && serviceStatus.version !== null) {
      // The running host has work in progress, so the CLI refused to restart
      // it. Keep it for the renderer's compat probe.
      const kept = await surfaceBusyHostKeep(bridge, serviceStatus.version);
      if (kept !== null) {
        log.info(
          "[host-ensure] host busy - kept for the renderer compat probe",
        );
        return kept;
      }
      log.warn(
        "[host-ensure] host-busy but no reachable snapshot surfaced - routing to recovery",
      );
    }
    log.warn("[host-ensure] CLI ensure failed", {
      kind: categorized.kind,
      code: categorized.code,
    });
    throw new Error(categorized.message);
  }

  const lifecycle = readServiceLifecycle(payload as HostEnsureResultPayload);
  if (lifecycle.postSwapError !== null) {
    log.warn("[host-ensure] service registration reported postSwapError", {
      postSwapError: lifecycle.postSwapError,
    });
    throw new Error(
      `The host was installed but its background service did not start cleanly: ${lifecycle.postSwapError}. Open Doctor or run 'traycer host doctor' to recover.`,
    );
  }

  // Close the host-owned restart window (#8): on this path the CLI installed
  // the new bytes inertly (`--no-service-register`) and the host teardown
  // happens HERE, in the desktop's SMAppService unregister→register cycle -
  // seconds after the CLI's pre-install busy check, long enough for a turn to
  // start during the install. So re-probe the still-running old host right
  // before the cycle. If it is now busy, keep it (exactly like the CLI
  // host-busy path): the freshly installed bytes stay on disk and the
  // renderer compat-probes the running old host instead of us booting it out.
  // `prePid !== null` means a host was running when we started; only then is
  // there a live host for the cycle to displace.
  if (
    hostOwnsLoginItem &&
    prePid !== null &&
    serviceStatus.listenUrl !== null &&
    serviceStatus.version !== null &&
    !force &&
    (await probeHostActivityBusy(serviceStatus.listenUrl))
  ) {
    const kept = await surfaceBusyHostKeep(bridge, serviceStatus.version);
    if (kept !== null) {
      log.info(
        "[host-ensure] host became busy before the SMAppService restart - kept for the renderer compat probe",
      );
      return kept;
    }
    log.warn(
      "[host-ensure] host busy before SMAppService restart but no reachable snapshot surfaced - proceeding with restart",
    );
  }

  // Register + start the host as a macOS login item via SMAppService so
  // System Settings → Login Items shows the proper app name + icon. The
  // register helper does an unregister→register cycle so BTM drops its
  // cached LWCR for the previous bundle's CDHash - without that, launchd
  // refuses to spawn the new helper with `EX_CONFIG` and the readiness
  // poll below times out against an empty `host.log`. See
  // `host-login-item.ts:registerHostLoginItem` for the full rationale.
  if (hostOwnsLoginItem) {
    // Pre-flight, only when a host was running at ensure start: `requires-
    // approval` means the user has the login item toggled off in System
    // Settings. The register cycle cannot flip that toggle back - it would
    // land on `requires-approval` again - but its leading bootout WOULD
    // kill the still-running host first. Surface the same approval error
    // the post-cycle check would, without the kill. With nothing running
    // there is nothing to protect, so the cycle proceeds (and reports the
    // approval state itself if it persists).
    if (prePid !== null && readHostLoginItemStatus() === "requires-approval") {
      throw new Error(approvalRequiredMessage());
    }
    // No revalidation guard here (unlike the pending-revision fast path
    // below): this call follows a full CLI provisioning round-trip, and the
    // busy re-check a few lines up already surfaces a host that became busy
    // before reaching this point. Scoped out for now - see PR discussion.
    const loginItemStatus = await registerHostLoginItem(undefined);
    if (loginItemStatus === "removed-by-user") {
      // The user hit "Remove Traycer" while this ensure was in flight; the
      // locked register cycle refused to resurrect the login item. Mirror
      // the entry check's result so the renderer shows the removed surface.
      log.info("[host-ensure] skipped - host removed by user mid-ensure");
      return { action: "removed", running: false, version: null };
    }
    if (loginItemStatus === "requires-approval") {
      throw new Error(approvalRequiredMessage());
    }
    if (loginItemStatus !== "enabled") {
      // `not-registered` / `not-found` / `not-supported` here all mean
      // SMAppService refused to load our in-bundle plist - there is no
      // amount of waiting that will publish pid metadata. Fail fast so
      // the renderer routes to Doctor instead of spinning for 60s.
      log.warn("[host-ensure] SMAppService did not enable the agent", {
        status: loginItemStatus,
      });
      throw new Error(
        `The host's macOS login item could not be enabled (status: ${loginItemStatus}). Open Doctor or run 'traycer host doctor' to recover.`,
      );
    }
  }

  // The CLI can report success before the OS service has spawned the host
  // and bound its WS port - wait for the on-disk pid metadata to confirm
  // reachability before telling the renderer the host is ready.
  //
  // `prePid` is null on a clean install (nothing was running) and the old
  // host's pid when we are replacing a stale running build - in that case
  // the register cycle boots the old host out, so the poll must skip its
  // lingering pid.json and wait for the freshly spawned process.
  const pidPath = getHostFsLayout(environment).pidMetadataFile;
  const readiness = await waitForHostReady(
    HOST_READY_TIMEOUT_MS,
    pidPath,
    HOST_READY_POLL_MS,
    prePid,
  );
  if (!readiness.ready) {
    // Re-read the SMAppService status: macOS can flip the agent to
    // `requires-approval` mid-wait (e.g. the user toggled it off in
    // System Settings while we were polling), and that produces the same
    // empty-pid-metadata symptom as a host that simply didn't bind. A
    // status check here lets us tell the user *why* the wait failed.
    const postWaitStatus = hostOwnsLoginItem ? readHostLoginItemStatus() : null;
    log.warn("[host-ensure] host did not become reachable in time", {
      reason: readiness.reason,
      loginItemStatus: postWaitStatus,
    });
    if (postWaitStatus === "requires-approval") {
      throw new Error(approvalRequiredMessage());
    }
    throw new Error(
      `The host was set up but did not become reachable in time (${readiness.reason}). Open Doctor or run 'traycer host doctor' to recover.`,
    );
  }

  log.info("[host-ensure] host provisioned and reachable", {
    version: readiness.version,
    pid: readiness.pid,
  });
  // `waitForHostReady` proved reachability with its own private poll; the
  // lifecycle snapshot the renderer reads knows nothing about it yet. Push
  // the result into `HostLifecycle` instead of hoping the pid.json watcher
  // edge lands after the port is answering - in the 2026-07-14 incident the
  // main process logged this exact success while every chat tab stayed on
  // "Bound host is offline" until an app restart.
  await bridge.options.host.reloadSnapshotFromDisk();
  return { action: "provisioned", running: true, version: readiness.version };
}

// Session quarantine for the fast-path refresh. Set when the refresh is
// known to be pointless (or worse) for the rest of this process:
//   - a cycle RAN and still did not land `enabled` - its leading bootout
//     already killed the running host once, and retrying (the monitor ticks
//     every 30s) would kill a revived host again for the same terminal
//     outcome;
//   - the pre-flight read `requires-approval` - only the user flipping the
//     System Settings toggle resolves that, and per the monitor's own
//     doctrine such states are not retried within a session.
// The marker stays on disk either way, so the next launch's single ensure
// attempt gets its shot once whatever blocked the cycle is resolved. The
// pending-revision monitor consults this via the exported getter and stops
// ticking for the session - without that, a quarantined fast path makes
// every ensure RESOLVE `already-ready`, the monitor's failure budget never
// increments, and it would churn a no-op ensure every 30s forever.
let pendingRevisionRefreshQuarantined = false;

export function isPendingRevisionRefreshQuarantined(): boolean {
  return pendingRevisionRefreshQuarantined;
}

/** Test-only: module state would otherwise leak across test cases. */
export function resetPendingRevisionQuarantineForTests(): void {
  pendingRevisionRefreshQuarantined = false;
}

// A busy/indeterminate `desktop-install-cloud.js` update preserves the
// running host instead of booting it out, so its LaunchAgent keeps the
// launchd registration it had before the bundle swap - the freshly written
// plist (e.g. a new descriptor limit) sits inert until something re-runs the
// SMAppService cycle. The installer marks this with a pending-revision file
// (see `getHostFsLayout`'s doc comment); this is the fast path's chance to
// apply it, but ONLY once the host reports idle - the whole point of the
// installer preserving it was to not interrupt in-progress work, and this
// restart would do exactly that if run while busy. Returns the ensure
// result to return to the caller when a refresh (successful or not needed)
// was handled here, or `null` to fall through to the normal already-ready
// return unchanged.
async function applyPendingLoginItemRevisionIfIdle(
  environment: Environment,
  hostOwnsLoginItem: boolean,
  listenUrl: string,
  prePid: number | null,
): Promise<HostEnsureIpcResult | null> {
  if (!hostOwnsLoginItem) return null;
  if (pendingRevisionRefreshQuarantined) return null;
  if (!(await hasPendingLoginItemRevision(environment))) return null;
  if (await probeHostActivityBusy(listenUrl)) {
    log.debug(
      "[host-ensure] pending LaunchAgent revision deferred - host busy",
    );
    return null;
  }
  // Pre-flight: with the login item toggled off in System Settings the
  // cycle is guaranteed futile (only the user can re-enable it) AND
  // destructive (its leading bootout kills the healthy host we just probed).
  // Skip AND quarantine for the session: retrying every 30s cannot help
  // (the toggle is the user's alone) and would only churn; the marker
  // survives for the next launch, which runs after any re-enable anyway.
  if (readHostLoginItemStatus() === "requires-approval") {
    pendingRevisionRefreshQuarantined = true;
    log.warn(
      "[host-ensure] pending LaunchAgent revision quarantined for this session - login item requires approval in System Settings; the marker will be retried at the next launch",
    );
    return null;
  }
  log.info(
    "[host-ensure] host idle with a pending LaunchAgent revision - refreshing SMAppService registration",
  );
  // The busy probe above can go stale while this cycle waits its turn on
  // the shared registration lock (a concurrent `respawnHost` or another
  // ensure can be mid-cycle right now) - re-check right before the bootout
  // actually runs, so a host that picked up real work while queued isn't
  // killed anyway.
  const status = await registerHostLoginItem(
    async () => !(await probeHostActivityBusy(listenUrl)),
  );
  if (status === "removed-by-user") {
    log.info("[host-ensure] skipped - host removed by user mid-ensure");
    return { action: "removed", running: false, version: null };
  }
  if (status === "deferred-busy") {
    log.debug(
      "[host-ensure] pending LaunchAgent revision deferred - host became busy while queued behind another registration cycle",
    );
    return null;
  }
  if (status === "requires-approval") {
    pendingRevisionRefreshQuarantined = true;
    throw new Error(approvalRequiredMessage());
  }
  if (status !== "enabled") {
    pendingRevisionRefreshQuarantined = true;
    log.warn(
      "[host-ensure] pending LaunchAgent revision refresh did not enable the agent",
      { status },
    );
    throw new Error(
      `The host's macOS login item could not be enabled (status: ${status}). Open Doctor or run 'traycer host doctor' to recover.`,
    );
  }
  const pidPath = getHostFsLayout(environment).pidMetadataFile;
  const readiness = await waitForHostReady(
    HOST_READY_TIMEOUT_MS,
    pidPath,
    HOST_READY_POLL_MS,
    prePid,
  );
  if (!readiness.ready) {
    log.warn(
      "[host-ensure] host did not become reachable after applying a pending LaunchAgent revision",
      { reason: readiness.reason },
    );
    throw new Error(
      `The host's background service was refreshed but did not become reachable in time (${readiness.reason}). Open Doctor or run 'traycer host doctor' to recover.`,
    );
  }
  log.info("[host-ensure] pending LaunchAgent revision applied", {
    version: readiness.version,
    pid: readiness.pid,
  });
  return { action: "already-ready", running: true, version: readiness.version };
}

// Keep a running-but-busy host instead of restarting it: surface it so the
// renderer can connect and run its compat probe. Judge "surfaced" off the value
// `reloadSnapshotFromDisk()` returns (the snapshot THIS reload derived), NOT a
// follow-up `getSnapshot()` - a concurrent pid.json-watcher reload can supersede
// ours and leave `getSnapshot()` momentarily stale. Returns the `host-busy`
// result when a reachable snapshot was surfaced, else `null` so the caller
// routes to normal recovery / restart.
// Resolve the host-runtime archive bundled beside the desktop's CLI binary
// (`resources/cli/<platform>-<arch>/host-runtime-<platform>-<arch>.tar.gz`,
// staged by scripts/desktop-install-cloud.js). Windows-only: on POSIX the slot
// CLI is a symlink into the bundle, so the CLI resolves the sibling archive
// itself and we must NOT override its source resolution. Returns null when
// there is no packaged archive (dev builds, CLI-only installs).
async function resolveWindowsBundledHostArchive(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const bundledCli = await resolveBundledCliPath();
  if (bundledCli === null) return null;
  // No native Windows arm64 host - arm64 runs the x64 runtime (mirrors
  // resolveBundledHostArchive in the CLI).
  const arch = process.arch === "arm64" ? "x64" : process.arch;
  const archive = join(
    dirname(bundledCli),
    `host-runtime-win32-${arch}.tar.gz`,
  );
  try {
    await access(archive, constants.R_OK);
    return archive;
  } catch {
    return null;
  }
}

async function surfaceBusyHostKeep(
  bridge: RunnerIpcBridge,
  version: string,
): Promise<HostEnsureIpcResult | null> {
  const surfaced = await bridge.options.host.reloadSnapshotFromDisk();
  if (surfaced === null) {
    return null;
  }
  return { action: "host-busy", running: true, version };
}
