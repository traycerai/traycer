import { app } from "electron";
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { config, isDevBuild } from "../../config";
import { getHostFsLayout, labelForEnvironment } from "../host/host-paths";
import type { Environment } from "../host/host-paths";
import { isHostRemovedByUser } from "../host/host-removal-state";
import { log } from "./logger";

// macOS Login Items / Background Activity attribution for the host.
//
// Only `SMAppService` (callable from inside the .app bundle) produces a
// polished "Traycer" + icon row attributed to the app. So the desktop owns
// this one piece: it registers the in-bundle LaunchAgent plist via
// SMAppService, which both attributes the Login Items row to the app and
// loads + starts the agent. The host's install + lifecycle (and all
// launchd interaction) remain CLI-owned; the desktop installs the host
// bytes via `traycer host ensure --no-service-register`, then registers
// the login item here.
//
// This runs POST sign-in (auth-first boot), not at launch.

// Environment-scoped to match the in-bundle plist written by
// `desktop-install-cloud.js` (`hostAgentLabel`) and the CLI's
// `serviceLabelFor`: production → `ai.traycer.host`, other slots nest under
// their name. SMAppService resolves the plist by this exact filename.
const HOST_LABEL = labelForEnvironment(config.environment).id;
const HOST_SERVICE_NAME = `${HOST_LABEL}.plist`;

// Every SMAppService mutation for the host label must flow through this
// promise tail. `registerHostLoginItem` is a non-atomic bootout → unregister
// → register sequence; `ensureHost`, the pending-revision monitor, and
// `respawnHost` can all need it independently. Letting any two of them cross
// that boundary at the same time can leave BTM with the stale LWCR this module
// is designed to clear.
//
// This intentionally serializes rather than coalesces. The callers own their
// own policies (force-ensure handling, monitor failure budget, and respawn
// dedup/backoff), so a second caller must receive its own eventual result
// after the first cycle settles. The tail always resolves so a failed cycle
// never wedges later callers.
let hostLoginItemRegistrationTail: Promise<void> = Promise.resolve();

export function withHostLoginItemRegistrationLock<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = hostLoginItemRegistrationTail.then(operation);
  hostLoginItemRegistrationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Electron's `LoginItemSettings.status` is optional - `agentService`
 * registrations always populate it, but the type is shared with launch-item
 * settings that don't. We map every observed value into a closed union so
 * callers (`ensureHost`, the respawn handler) can branch exhaustively
 * instead of inspecting raw Electron strings.
 *
 * - `enabled` - registered AND loaded by launchd. The agent should spawn.
 * - `requires-approval` - registered but disabled by the user in System
 *   Settings → Login Items. launchd refuses to spawn until they re-enable.
 * - `not-registered` - SMAppService has no record of this plist.
 * - `not-found` - the in-bundle plist filename isn't where SMAppService
 *   looks. A packaging bug; never expected at runtime.
 * - `not-supported` - running on a platform/build where SMAppService is
 *   unavailable. Caller MUST gate with `hostManagesHostLoginItem()`.
 */
export type HostLoginItemStatus =
  | "enabled"
  | "requires-approval"
  | "not-registered"
  | "not-found"
  | "not-supported";

/**
 * `registerHostLoginItem`'s result: the SMAppService status the cycle
 * settled on, `removed-by-user` when the locked section found the removal
 * sentinel set and refused to run the cycle at all, or `deferred-busy` when
 * the caller's own `revalidateBeforeBootout` guard failed once the cycle
 * reached the front of the registration lock's queue (see the re-check
 * rationale in `registerHostLoginItemUnserialized`).
 */
export type RegisterHostLoginItemResult =
  HostLoginItemStatus | "removed-by-user" | "deferred-busy";

// True only when this is a shipped macOS build that ships the in-bundle
// LaunchAgent plist. Used by the ensure flow to decide whether the desktop
// owns registration (SMAppService) - and therefore passes
// `--no-service-register` to the CLI - or whether the CLI should register
// the service itself (non-macOS, or a build without the in-bundle plist).
// The dev slot never owns the login item: its host is managed by the
// `make dev-desktop` orchestrator / CLI, not SMAppService.
export async function hostManagesHostLoginItem(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (isDevBuild) return false;
  // Outside Electron - eg unit tests - `process.resourcesPath` is unset.
  // No bundle, no in-bundle plist, no host-owned registration.
  if (
    typeof process.resourcesPath !== "string" ||
    process.resourcesPath.length === 0
  ) {
    return false;
  }
  return fileExists(inAppLaunchAgentPlistPath());
}

/**
 * Reads the current SMAppService state for the host LaunchAgent without
 * mutating it. Used by the respawn / ensure flows to decide whether the
 * register cycle is needed and to enrich timeout errors with a specific
 * cause (e.g. `requires-approval`).
 */
export function readHostLoginItemStatus(): HostLoginItemStatus {
  // Electron's `getLoginItemSettings` is documented as non-throwing on the
  // agentService shape but its underlying SMAppService bridge has thrown
  // on broken BTM states in older macOS minor versions. We catch at this
  // boundary so callers see a stable `not-registered` instead of an
  // unhandled exception that would crash the main process or surface as
  // a raw Node error string to the renderer.
  try {
    const settings = app.getLoginItemSettings({
      type: "agentService",
      serviceName: HOST_SERVICE_NAME,
    });
    return normalizeStatus(settings.status);
  } catch (err) {
    log.warn("[host-login-item] getLoginItemSettings threw", err);
    return "not-registered";
  }
}

/**
 * Window we'll wait for the BTM database commit after a successful
 * `setLoginItemSettings({openAtLogin: true})` call before declaring the
 * status fatal. SMAppService.register returns before BTM has finished
 * persisting the entry on cold-BTM (first install) machines; observed
 * commit lag is sub-100ms but a few iOS-style ms-level retries here
 * costs nothing in steady state and prevents spurious Doctor routing.
 */
const REGISTER_STATUS_POLL_DEADLINE_MS = 1500;
const REGISTER_STATUS_POLL_INTERVAL_MS = 100;

/**
 * Register the in-bundle LaunchAgent as a login item via SMAppService.
 *
 * Caller must have confirmed `hostManagesHostLoginItem()` and installed
 * the host bytes first.
 *
 * The implementation begins with `launchctl bootout`, then runs an
 * SMAppService **unregister → register** pair. The bootout is the
 * load-bearing step on macOS 26+; the SMAppService cycle is kept for
 * defense-in-depth on older macOS where the bootout would be a no-op.
 *
 * SMAppService's BTM database caches a Lightweight Code Requirement
 * (LWCR) derived from the agent helper's CDHash at first registration.
 * When `make install-desktop-{staging,production}` replaces the .app
 * on disk, the helper's ad-hoc CDHash changes (ad-hoc signatures are
 * content-derived). On macOS ≤ 25, `SMAppService.unregister`
 * (`setLoginItemSettings({openAtLogin: false})`) drops the BTM entry
 * and the subsequent register installs a fresh LWCR. On macOS 26.5 (and
 * presumably 26+ generally) that path no longer flushes BTM — the
 * entry persists with the *old* CDHash, marked `needs LWCR update | has
 * LWCR` in `launchctl print gui/<uid>/<label>`. launchd then SIGKILLs
 * every spawn inside dyld init with `last exit code = 78: EX_CONFIG`
 * and a `Launch Constraint Violation` crash report. The symptom user-
 * side is empty `~/.traycer/host/<env>/host.log`, the 60s host-
 * ensure readiness wait timing out, and "pid metadata not yet
 * published" in the renderer.
 *
 * `launchctl bootout gui/<uid>/<label>` is the lever that *does* drop
 * the BTM entry on 26+: after bootout, `launchctl print` returns
 * `Could not find service`, and a fresh `SMAppService.register` then
 * installs an LWCR that matches the rebuilt binary's CDHash. Running
 * bootout before the SMAppService cycle is therefore the actual fix;
 * the SMAppService unregister we used to lean on is now belt-and-
 * suspenders for older macOS.
 *
 * Both Electron API calls are caught at this seam - `setLoginItemSettings`
 * can throw on the Objective-C bridge for malformed plists, missing
 * helper sub-app, or unsupported-platform paths. We turn any throw into
 * a `not-registered` return so the caller routes through Doctor with
 * a stable error rather than a raw `TypeError` / `NSError` message.
 *
 * After the register call we poll the status briefly: SMAppService
 * returns from `register` before BTM has committed the entry; a
 * synchronous status read can transiently say `not-registered` for
 * <100ms on cold-BTM (first-install) machines.
 */
// `revalidateBeforeBootout`, when provided, is called INSIDE the locked
// section immediately before `bootoutStaleAgent()` - not just at the call
// site - because a caller's own idle/busy check (e.g. the pending-revision
// fast path's `probeHostActivityBusy`) can go stale while queued behind
// another in-flight cycle (`respawnHost` and `runEnsureHost` share this same
// lock). Without a re-check here, a cycle that was idle when queued could
// still boot out a host that picked up real work while waiting its turn.
// Return `false` from the callback to defer without mutating anything;
// `registerHostLoginItemUnserialized` reports that back as `"deferred-busy"`.
export function registerHostLoginItem(
  revalidateBeforeBootout: (() => Promise<boolean>) | undefined,
): Promise<RegisterHostLoginItemResult> {
  return withHostLoginItemRegistrationLock(() =>
    registerHostLoginItemUnserialized(revalidateBeforeBootout),
  );
}

async function registerHostLoginItemUnserialized(
  revalidateBeforeBootout: (() => Promise<boolean>) | undefined,
): Promise<RegisterHostLoginItemResult> {
  // Re-checked HERE, inside the locked section, not only at the callers'
  // entry points: an ensure can spend minutes streaming the CLI before its
  // register lands on this lock's tail - possibly queued BEHIND an in-app
  // uninstall's `unregisterHostLoginItem()` (which persists the removed-by-
  // user sentinel before taking the lock). Without this check that queued
  // register would re-create the BTM login item right after "Remove
  // Traycer", and BTM would silently respawn the host at the next login.
  if (await isHostRemovedByUser()) {
    log.info(
      "[host-login-item] register skipped - host removed by user on this device",
    );
    return "removed-by-user";
  }

  if (
    revalidateBeforeBootout !== undefined &&
    !(await revalidateBeforeBootout())
  ) {
    log.info(
      "[host-login-item] register cycle deferred - caller's guard failed once dequeued from the registration lock (host is no longer idle)",
    );
    return "deferred-busy";
  }

  const plistPath = inAppLaunchAgentPlistPath();

  // Flush BTM's stale LWCR before touching SMAppService. On macOS 26+
  // this is the load-bearing step — SMAppService.unregister no longer
  // drops the BTM entry, so without bootout the subsequent register
  // hands launchd a stale CDHash and every spawn is SIGKILL'd inside
  // dyld init. See the docstring above for the full mechanism.
  await bootoutStaleAgent();

  const clearedOk = trySetLoginItemSettings(false);
  if (!clearedOk) {
    return "not-registered";
  }
  const cleared = readHostLoginItemStatus();
  log.info("[host-login-item] SMAppService cleared prior registration", {
    serviceName: HOST_SERVICE_NAME,
    plistPath,
    status: cleared,
  });

  const registeredOk = trySetLoginItemSettings(true);
  if (!registeredOk) {
    return "not-registered";
  }
  const status = await pollRegisterStatusUntilSettled();
  log.info("[host-login-item] SMAppService register result", {
    serviceName: HOST_SERVICE_NAME,
    plistPath,
    status,
  });
  if (status === "enabled") {
    // Whatever prompted this cycle (a normal ensure, or the already-ready
    // fast path applying a deferred install), the on-disk plist is now the
    // one active in launchd - any pending-revision marker the installer
    // left behind is resolved.
    await clearPendingLoginItemRevision(config.environment);
  }
  return status;
}

/**
 * Whether `scripts/desktop-install-cloud.js` (internal repo) left a pending
 * LaunchAgent revision marker for `environment` - see `getHostFsLayout`'s
 * doc comment for the full cross-repo contract. Best-effort: a read error
 * (permissions, race) is treated as "no pending revision" so a transient FS
 * hiccup never blocks the ensure fast path.
 */
export async function hasPendingLoginItemRevision(
  environment: Environment,
): Promise<boolean> {
  return fileExists(getHostFsLayout(environment).pendingLoginItemRevisionFile);
}

async function clearPendingLoginItemRevision(
  environment: Environment,
): Promise<void> {
  try {
    await rm(getHostFsLayout(environment).pendingLoginItemRevisionFile, {
      force: true,
    });
  } catch (err) {
    log.warn(
      "[host-login-item] failed to clear pending LaunchAgent revision marker",
      { err },
    );
  }
}

/**
 * Tear down the host's SMAppService login-item registration during an in-app
 * uninstall. The CLI's `host uninstall --all` boots out the launchd plist,
 * but on macOS 26+ the BTM entry the desktop registered via SMAppService
 * persists independently and would respawn the host at the next login. This
 * drops it: `launchctl bootout` flushes the BTM entry (the load-bearing step
 * on 26+) and `setLoginItemSettings({openAtLogin: false})` unregisters the
 * SMAppService record on older macOS. Best-effort and idempotent - a clean
 * machine (nothing registered) is a no-op.
 *
 * Caller must have confirmed `hostManagesHostLoginItem()` first; on every
 * other build there is no SMAppService registration to remove.
 */
export function unregisterHostLoginItem(): Promise<void> {
  return withHostLoginItemRegistrationLock(unregisterHostLoginItemUnserialized);
}

async function unregisterHostLoginItemUnserialized(): Promise<void> {
  await bootoutStaleAgent();
  const cleared = trySetLoginItemSettings(false);
  log.info("[host-login-item] SMAppService registration torn down", {
    serviceName: HOST_SERVICE_NAME,
    cleared,
  });
}

function trySetLoginItemSettings(openAtLogin: boolean): boolean {
  try {
    app.setLoginItemSettings({
      openAtLogin,
      type: "agentService",
      serviceName: HOST_SERVICE_NAME,
    });
    return true;
  } catch (err) {
    log.warn("[host-login-item] setLoginItemSettings threw", {
      openAtLogin,
      err,
    });
    return false;
  }
}

async function pollRegisterStatusUntilSettled(): Promise<HostLoginItemStatus> {
  const deadline = Date.now() + REGISTER_STATUS_POLL_DEADLINE_MS;
  let last: HostLoginItemStatus = readHostLoginItemStatus();
  // `enabled` and `requires-approval` are both terminal: register succeeded;
  // the only difference is whether the user has the toggle on. `not-found`
  // and `not-supported` are also terminal failures - no amount of polling
  // changes those. Only `not-registered` is potentially transient (cold-BTM
  // commit lag), so that's the one we retry.
  while (last === "not-registered" && Date.now() < deadline) {
    await sleep(REGISTER_STATUS_POLL_INTERVAL_MS);
    last = readHostLoginItemStatus();
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(raw: string | undefined): HostLoginItemStatus {
  // Electron exposes the SMAppService statuses by these exact strings on
  // macOS 13+. Anything else (older OS, `status` omitted on a non-agent
  // settings shape) falls through to `not-registered` so callers fail
  // closed and rerun the cycle.
  if (
    raw === "enabled" ||
    raw === "requires-approval" ||
    raw === "not-registered" ||
    raw === "not-found" ||
    raw === "not-supported"
  ) {
    return raw;
  }
  return "not-registered";
}

function inAppLaunchAgentPlistPath(): string {
  // `process.resourcesPath` is `<App>.app/Contents/Resources/`; `dirname`
  // brings us to `Contents/` → `Contents/Library/LaunchAgents/<name>.plist`.
  // `HOST_SERVICE_NAME` already includes the `.plist` suffix.
  const contentsDir = dirname(process.resourcesPath);
  return join(contentsDir, "Library", "LaunchAgents", HOST_SERVICE_NAME);
}

/**
 * Time we let `launchctl bootout` run before killing it. Bootout is a
 * fast launchd RPC; observed wall-clock is <50ms on a healthy system.
 * The 5s ceiling exists to bound a launchd hang (rare, but seen during
 * launchd recovery after a wake-from-sleep) so the register cycle
 * isn't held hostage by a wedged subprocess.
 */
const BOOTOUT_TIMEOUT_MS = 5_000;

/**
 * Forcibly drop the host agent from launchd's GUI domain so BTM
 * releases its cached LWCR. On macOS 26+ this is the only path that
 * actually flushes BTM — see `registerHostLoginItem`'s docstring for
 * the mechanism. Safe to call on a clean machine: launchctl exits
 * non-zero with "not loaded" semantics (codes 3 / 5 / 113), which we
 * treat as success.
 *
 * Best-effort: a non-darwin host, an unavailable `getuid`, a spawn
 * that throws or errors, or a process that overruns the timeout each
 * log and return so the caller's register cycle still runs. The worst
 * case is we degrade to the pre-fix behavior for this one call.
 */
async function bootoutStaleAgent(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const target = `gui/${uid}/${HOST_LABEL}`;
  // Wrap `spawn` so TypeScript resolves the (command, args, options)
  // overload here rather than against the `BootoutSpawnFn` alias.
  //
  // `runLaunchctlBootout` catches async failures (error event, non-
  // zero exit, timeout); the try/catch here covers the synchronous
  // throw path from `spawn` itself (invalid arguments, no /bin/launchctl
  // at all). Either way the register cycle continues — the docstring
  // promises best-effort.
  try {
    await runLaunchctlBootout(target, (command, args, options) =>
      spawn(command, args, options),
    );
  } catch (err) {
    log.warn(
      "[host-login-item] launchctl bootout threw — proceeding without bootout",
      { target, err },
    );
  }
}

/**
 * The minimal `child_process.spawn` surface `runLaunchctlBootout`
 * depends on. Pulled out so unit tests can pass a stub without mocking
 * `node:child_process` itself — vitest's jsdom environment doesn't
 * intercept `import { spawn } from "node:child_process"` reliably, and
 * passing the dependency explicitly is the cleanest way to keep the
 * spawn-side behavior (timeout, kill, exit-code classification)
 * testable in isolation.
 */
export interface BootoutChildProcess {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: "SIGTERM"): boolean;
}
export type BootoutSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { stdio: "ignore" },
) => BootoutChildProcess;

/**
 * Spawn `launchctl bootout <target>` and wait for it to exit, or kill
 * it once `BOOTOUT_TIMEOUT_MS` has elapsed. Resolves either way — the
 * BTM-clearing side effect is durable: a process that hangs after
 * issuing the bootout RPC still leaves BTM cleared.
 *
 * Exit-code classification:
 *   - 0 — bootout succeeded, agent was loaded and is now gone
 *   - 3 / 5 / 113 — agent was not loaded; nothing to clear (no-op
 *     success on a clean machine). Codes are macOS-version-dependent:
 *     observed 3 (ENOSRCH) on 14+, 5 ("Could not find service"), and
 *     113 ("Service is not loaded") historically.
 *   - anything else — a real launchctl failure (permission denied,
 *     corrupted launchd state). Logged at warn so a wedged BTM isn't
 *     silently swallowed and rediscovered as a downstream SIGKILL.
 *
 * `spawnFn` is injected so this function is testable in isolation;
 * the production call site passes the real `node:child_process.spawn`.
 * Exported for unit tests; never call this from new production code —
 * use `bootoutStaleAgent` instead.
 */
export function runLaunchctlBootout(
  target: string,
  spawnFn: BootoutSpawnFn,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnFn("/bin/launchctl", ["bootout", target], {
      stdio: "ignore",
    });
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      log.warn("[host-login-item] launchctl bootout exceeded timeout, killed", {
        target,
        timeoutMs: BOOTOUT_TIMEOUT_MS,
      });
      settle();
    }, BOOTOUT_TIMEOUT_MS);
    child.once("error", (err) => {
      log.warn("[host-login-item] launchctl bootout errored", {
        target,
        err,
      });
      settle();
    });
    child.once("exit", (code) => {
      if (code === 0) {
        log.info("[host-login-item] launchctl bootout cleared BTM entry", {
          target,
        });
      } else if (code === 3 || code === 5 || code === 113) {
        // "Not loaded" — nothing to clear. Common on first install.
        log.info(
          "[host-login-item] launchctl bootout: agent not loaded (clean state)",
          { target, code },
        );
      } else {
        log.warn(
          "[host-login-item] launchctl bootout returned unexpected exit code — BTM may still hold a stale LWCR",
          { target, code },
        );
      }
      settle();
    });
  });
}

function fileExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}
