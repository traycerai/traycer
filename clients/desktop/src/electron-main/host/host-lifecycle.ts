import { mkdir, readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { connect as createTlsConnection } from "node:tls";
import { basename } from "node:path";
import { log } from "../app/logger";
import {
  PRODUCTION_LABEL,
  type HostFsLayout,
  type ServiceLabel,
} from "./host-paths";
import {
  withConfiguredHostName,
  withDefaultHostName,
} from "./host-display-name";
import {
  isProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle";
import type {
  DesktopLocalHostSnapshot,
  DesktopPublishedHostSnapshot,
} from "../../ipc-contracts/host-types";
import {
  isCurrentHostWebsocketUrl,
  readPublishedHostPresence,
  type PublishedHostPresence,
  type PublishedProcessIdentityQuery,
} from "./host-endpoint-reachability";
import {
  getPublishedProcessIdentityVerdict,
  type PublishedProcessIdentityVerdict,
} from "./process-identity";
import {
  foldHostAvailability,
  needsReprobe,
  INITIAL_HOST_AVAILABILITY_STATE,
  type HostAvailabilityState,
} from "./host-availability-state";

export { isCurrentHostWebsocketUrl } from "./host-endpoint-reachability";

/**
 * How long we wait for the OS-supervised host to publish its PID
 * metadata before surfacing a Doctor-recovery startup failure to the
 * renderer. The CLI supervisor (`traycer host start`) sources the
 * user's shell as part of bootstrap, so this needs to absorb the user's
 * full rc-file init cost. 60s is sized for slow oh-my-zsh setups +
 * Prisma/native init.
 *
 * It is a QUIET budget, not a wall-clock one: `notifyProvisioningActivity`
 * re-arms it, exactly the way the CLI's own inactivity guard re-arms on every
 * NDJSON progress event. A first install downloads ~800MB and extracts a
 * multi-gigabyte runtime tree, which on a slow or AV-scanned machine takes
 * minutes - a flat 60s deadline declared "Could not start Traycer Host" while
 * that install was demonstrably still progressing (traycer#862, and again in
 * traycer#858's desktop log).
 */
const HOST_READY_TIMEOUT_MS = 60_000;
/**
 * Ceiling on the total wait regardless of progress, so an installer that
 * emits events forever can never hold bootstrap open indefinitely. Sized well
 * above a realistic worst-case first install (the field report that motivated
 * the sliding budget took ~3m17s) while still bounded.
 */
const HOST_READY_MAX_WAIT_MS = 15 * 60_000;
const HOST_POLL_INTERVAL_MS = 250;
const HOST_ENDPOINT_CHECK_TIMEOUT_MS = 750;
const CLI_START_STOP_TIMEOUT_MS = 60_000;
/**
 * Backoff ladder for re-probing a pid.json that is present but whose
 * endpoint didn't answer. The pid-file watcher is edge-triggered on file
 * WRITES while reachability is time-varying, so a single probe failure at
 * the only watcher edge used to wedge `currentSnapshot` at null for the
 * rest of the session (2026-07-14 incident: host reachable 7s after the
 * ensure timeout, renderer stuck on "Bound host is offline" until an app
 * restart). While metadata exists but the endpoint is unreachable, keep
 * re-probing - the host is either still binding (converges in the next
 * shot or two) or genuinely dead (the health monitor / ensure flows own
 * that; a capped 5s loopback probe is negligible to keep running).
 *
 * The ladder now also runs while the published verdict is DEGRADED
 * (`needsReprobe`), not only while the snapshot is null. A busy host keeps a
 * non-null snapshot, so keying the ladder off `next === null` alone would have
 * left the degraded verdict with nothing scheduled to lift it - which is the
 * 2026-08-11 wedge repeated one state to the left.
 */
const REACHABILITY_RETRY_INITIAL_MS = 250;
const REACHABILITY_RETRY_MAX_MS = 5_000;
/**
 * How long a non-death process-identity verdict may be reused while the ladder
 * above keeps re-probing an endpoint that is not answering.
 *
 * Deliberately the same 120s, and the same shape, as the health monitor's busy
 * shield (`ALIVE_RECHECK_INTERVAL_MS` in `host-health-monitor.ts`), because it
 * is the same cost: each verdict spawns a child process (`ps` on POSIX,
 * `tasklist` plus `powershell` on Windows). The monitor pays it at a 15s tick;
 * this ladder runs at 250ms rising to 5s and does not stop while a host stays
 * wedged, so unthrottled it is ~720 spawns an hour, for an answer that changes
 * at most once.
 *
 * What is NOT throttled, and must not be:
 *   - a verdict read on a probe that ANSWERED. The identity check is the only
 *     thing standing between an impostor listener on the host's port and a
 *     published `available`, so the path where a handshake succeeded always
 *     asks the OS afresh.
 *   - a `dead` or `mismatch` verdict. Those are the two that decide DEATH
 *     (`readPublishedHostPresence` maps them to `absent`), and a positive death
 *     must never be served from a cache. They are also free to re-read: a dead
 *     pid loses the liveness probe before any child process is spawned.
 */
const IDENTITY_VERDICT_REUSE_MS = 120_000;

export interface HostLifecycleEvents {
  change: (snapshot: DesktopPublishedHostSnapshot | null) => void;
  error: (error: HostStartupError) => void;
}

/**
 * Discriminated failure codes surfaced from the host lifecycle. Keeping a
 * `code` on the error lets the renderer show a targeted message.
 *
 * Native-packaging cutover: Desktop no longer installs/upgrades the host
 * itself - CLI is the lifecycle authority (Tech Plan Decision 1). The
 * legacy `BUNDLED_HOST_MISSING` and `SERVICE_INSTALL_FAILED` codes are
 * retained in the discriminant for backwards-compat with renderer error
 * rendering, but are no longer raised by the steady-state boot path -
 * a missing/unreachable host now surfaces as `HOST_NOT_READY` and
 * the renderer routes into the Doctor/CLI recovery card.
 *
 * Host Update Layer Redesign Tech Plan (Desktop main: HostController):
 * `SERVICE_RESTART_FAILED` joins that same retained-but-unraised set -
 * `respawn()` (the CLI-subprocess restart it used to come from) moved to
 * `HostController`, which reports restart failures through its own
 * `MutationOutcome`, not this discriminant.
 */
export type HostStartupErrorCode =
  | "BUNDLED_HOST_MISSING"
  | "SERVICE_INSTALL_FAILED"
  | "SERVICE_RESTART_FAILED"
  | "HOST_NOT_READY"
  | "UNKNOWN";

export interface HostStartupError {
  readonly code: HostStartupErrorCode;
  readonly message: string;
  readonly logTail: string | null;
}

class HostStartupException extends Error {
  public readonly code: HostStartupErrorCode;
  constructor(code: HostStartupErrorCode, message: string) {
    super(message);
    this.name = "HostStartupException";
    this.code = code;
  }
}

export interface HostLifecycleOptions {
  readonly layout: HostFsLayout;
  /**
   * Absolute path to the host binary bundled inside the desktop app's
   * `extraResources/host/...`, or `null` for steady-state packaged boot
   * where the host is CLI-installed (Tech Plan Decision 1). Tests still
   * pass a path when exercising legacy fakes; production always passes
   * `null`.
   */
  readonly bundledBinaryPath: string | null;
  /**
   * Service registration label. Packaged Desktop passes `PRODUCTION_LABEL`
   * and reads `~/.traycer/host/`; unpackaged Desktop (`make dev-desktop`)
   * passes `DEV_LABEL` and the matching dev-environment layout so it
   * reads/watches `~/.traycer/host/dev/`. The two must agree - the
   * environment of `label` is selected at the boot seam in `main-process.ts`
   * and threaded into both `layout` and the CLI subprocess calls.
   */
  readonly label: ServiceLabel;
  /**
   * Optional override for the PID-metadata wait timeout. Production omits
   * this and uses the module-level `HOST_READY_TIMEOUT_MS` (60s); tests
   * pass a short value so they can assert the missing-metadata path
   * surfaces `HOST_NOT_READY` without blocking the suite.
   */
  readonly readyTimeoutMs: number | undefined;
  /**
   * Override for the websocket-reachability probe. Production passes
   * `undefined` and uses the real TCP connect (`canReachHostWebsocketUrl`);
   * tests inject a deterministic stub so reachability transitions don't depend
   * on binding/rebinding real sockets (a CI-flaky timing dependency).
   */
  readonly reachabilityProbe:
    ((websocketUrl: string) => Promise<boolean>) | undefined;
}

/**
 * Owns the local host on behalf of the Electron shell.
 *
 * Native-Packaging cutover (Tech Plan Decision 1, Ticket 7c890b39):
 *   - Steady-state boot is **metadata-first**. The lifecycle reads the
 *     environment-scoped `pid.json`, validates the websocket URL shape and
 *     reachability, and emits a `LocalHostSnapshot` when the host is
 *     reachable. The Desktop service controller (SMAppService /
 *     launchctl / systemctl / schtasks) is NOT consulted - host install
 *     state is owned by the CLI's LaunchAgent/unit/task registration and
 *     SMAppService state would falsely report `not-installed` against it.
 *   - If no reachable host metadata appears within `readyTimeoutMs`,
 *     the lifecycle surfaces a `HOST_NOT_READY` startup error so the
 *     renderer can route the user into the Doctor recovery card
 *     (`traycer host doctor`) - Desktop does not infer install state
 *     from the legacy service-manager dispatch any more.
 *   - User-invoked start / stop / restart actions delegate through CLI
 *     subprocess (`traycer host restart` / `traycer host stop`)
 *     instead of the platform service-manager APIs.
 *
 * Responsibilities:
 *   - Read the published PID metadata file from the active environment's
 *     host directory (prod = `~/.traycer/host/pid.json`,
 *     dev = `~/.traycer/host/dev/pid.json`).
 *   - Watch the metadata file for updates and re-emit `LocalHostSnapshot`
 *     values as they change so the renderer bridge can push them through
 *     `onLocalHostChange`.
 *   - Surface startup diagnostics by tailing the matching `host.log`.
 *   - Expose `respawn()` so the renderer can request a fresh host process
 *     via IPC when the current one is unhealthy - implemented as a CLI
 *     `traycer host restart` subprocess.
 *
 * The class stays transport-agnostic - it never opens the host's
 * WebSocket endpoint. That is the renderer/`WsRpcClient`'s job per the
 * no-bridge-proxying constraint.
 */
export class HostLifecycle extends EventEmitter {
  private readonly options: HostLifecycleOptions;
  private readonly readyTimeoutMs: number;
  private watcher: FSWatcher | null = null;
  private currentSnapshot: DesktopPublishedHostSnapshot | null = null;
  /**
   * Rolling verdict fold (hysteresis + degradation policy). Owned here because
   * this class owns the only clock that can re-examine it.
   */
  private availability: HostAvailabilityState = INITIAL_HOST_AVAILABILITY_STATE;
  /** Coalesces out-of-band repair reloads onto one in-flight read. */
  private repairInFlight = false;
  private reloadGeneration = 0;
  private disposed = false;
  private reachabilityRetryTimer: NodeJS.Timeout | null = null;
  private reachabilityRetryDelayMs = REACHABILITY_RETRY_INITIAL_MS;
  /**
   * The last non-death identity verdict and when it was read, kept per pid so a
   * REPLACEMENT host is always judged on its own evidence. See
   * {@link IDENTITY_VERDICT_REUSE_MS}.
   */
  private identityVerdictCache: {
    readonly pid: number;
    readonly verdict: PublishedProcessIdentityVerdict;
    readonly readAt: number;
  } | null = null;
  /**
   * Epoch ms of the last reported host-provisioning progress event, or 0 when
   * none has been seen. Read only by `waitForReady`, which treats it as the
   * point its quiet budget restarts from.
   */
  private lastProvisioningActivityAt = 0;

  constructor(options: HostLifecycleOptions) {
    super();
    this.options = options;
    this.readyTimeoutMs =
      typeof options.readyTimeoutMs === "number"
        ? options.readyTimeoutMs
        : HOST_READY_TIMEOUT_MS;
  }

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return this.currentSnapshot;
  }

  /**
   * Entry point: discover the CLI-owned host via PID metadata.
   *
   * Metadata-first boot (Ticket 7c890b39):
   *   - read the environment-scoped pid metadata file
   *   - if it's well-formed and the websocket URL is reachable, emit a
   *     `LocalHostSnapshot`
   *   - otherwise poll for `readyTimeoutMs`; on timeout emit
   *     `HOST_NOT_READY` so the renderer routes into Doctor/CLI recovery
   *   - install the FS watcher unconditionally so a host that comes up
   *     after the timeout (slow zsh init, slow Prisma/native load) is
   *     auto-detected the moment it publishes `pid.json`
   *
   * The Desktop service controller is **not** consulted from this surface
   * - `status(...)` against the legacy SMAppService-backed controller can
   * falsely report `not-installed` against a CLI-owned LaunchAgent
   * registration. Install / upgrade / register-service actions are all
   * CLI-owned (Tech Plan Decision 1). `hostInstalled` is therefore handed
   * IN by the caller rather than read here - the boot seam already holds a
   * controller and resolves it there.
   *
   * @param options.hostInstalled Whether this machine has a host install
   * record at all. `false` means nothing was ever installed, which is a
   * different state from "installed but not up yet" and must not be waited
   * out - see the readiness short-circuit below.
   */
  async bootstrap(options: { readonly hostInstalled: boolean }): Promise<void> {
    // Ahead of BOTH watcher installs below - the success path and the catch.
    await this.ensureWatchableRootDir();
    try {
      await this.reloadSnapshot();
      if (!this.isCompatible(this.currentSnapshot)) {
        // Nothing is installed on this machine, so nothing is coming. The
        // launch converge deliberately refuses to provision a
        // never-installed host before sign-in
        // (`host-launch-converge.ts`'s `isUnavailableInstalledHost`), which
        // means no provisioning lane exists to extend the quiet budget
        // below - it would run the full timeout every time and then report
        // that a host "did not start" when nothing ever asked it to.
        //
        // That line is not free: it lands at ERROR in the desktop.log
        // attached to every support report from a fresh install, where it
        // has already misdirected three field investigations
        // (traycer#961, #996, #1001), and holding `bootstrap` open delays
        // the deferred work gated on it - the host health monitor (which
        // owns Windows auto-respawn) and the macOS login-item revision
        // monitor. The watcher installed below is what picks the host up
        // once the user signs in and provisioning actually runs.
        if (options.hostInstalled) {
          await this.waitForReady();
        } else {
          log.info(
            "[host] no host installed on this machine yet - skipping the readiness wait",
          );
        }
      }
      this.installWatcher();
    } catch (cause) {
      // Install the watcher even on failure so a host that comes up
      // *after* the timeout (slow zsh probe, slow Prisma/native init)
      // auto-heals when it eventually publishes pid.json - the renderer
      // doesn't need to click Retry.
      this.installWatcher();
      const startupError = await this.buildStartupError(cause);
      log.error("[host] startup failed", startupError);
      this.emit("error", startupError);
    }
  }

  /**
   * Mark the host as "currently down" from the renderer's perspective.
   *
   * Used by `HostController`'s macOS host-owned-login-item activation cycle
   * so it can drive the SMAppService re-register cycle itself while still
   * keeping the renderer's cached snapshot consistent (cleared on respawn
   * start, repopulated by the existing pid-file watcher when the new host
   * publishes pid.json). `HostController`'s CLI-owned restart path
   * (`traycer host restart`) does not call this - it shells out directly
   * rather than through this lifecycle.
   */
  notifyRespawning(): void {
    if (this.disposed) return;
    this.currentSnapshot = null;
    this.availability = INITIAL_HOST_AVAILABILITY_STATE;
    this.emit("change", null);
    // The replacement host is a different process, so nothing the last one
    // proved about its identity applies to it.
    this.identityVerdictCache = null;
    // Arm the ladder for the same reason `reloadSnapshot` does: this is a
    // hand-written demotion, so no reload decided anything about re-probing,
    // and the replacement host may publish the SAME pid.json content the
    // watcher is edge-triggered on. Leaving it unarmed is a null snapshot with
    // nothing scheduled to lift it - the shape of the 2026-08-11 wedge.
    //
    // Cleared FIRST so the arm starts at the bottom of the ladder: a respawn is
    // new information, and a pending timer inherited from the outage that
    // caused it would make the new host's first probe wait up to the 5s cap
    // before anything looked for it.
    this.clearReachabilityRetry();
    this.scheduleReachabilityRetry();
  }

  /**
   * Out-of-band evidence that the published endpoint just answered someone
   * ELSE - the health monitor's own probe, or the controller's status poll.
   *
   * The 2026-08-11 incident had successful probes running against this very
   * endpoint every few seconds for two hours while the renderer was still
   * being told the host was gone: nothing carried that success back to the one
   * component that owns the renderer-facing verdict. This is that edge.
   *
   * It re-reads rather than trusting the caller's boolean, so a verdict can
   * only ever be repaired by THIS class's own probe + liveness pair - the
   * caller's success is a reason to look again, not a substitute for looking.
   * It is a no-op once the verdict is already `available`, so the steady-state
   * cost of wiring it into a poll is one field comparison.
   */
  noteEndpointAnswered(): void {
    if (this.disposed) return;
    if (this.availability.published === "available") return;
    if (this.repairInFlight) return;
    this.repairInFlight = true;
    void this.reloadSnapshot()
      .catch((error: unknown) => {
        log.warn("[host] availability repair reload failed", error);
      })
      .finally(() => {
        this.repairInFlight = false;
      });
  }

  /**
   * Report that host provisioning made progress just now.
   *
   * Wired from `HostController.onMutationProgress` at startup - the CLI emits
   * an NDJSON progress event per download chunk / extraction stage, and the
   * desktop already re-arms its inactivity-SIGKILL guard off that same stream.
   * `waitForReady` re-arms its own budget here for the same reason: an install
   * that is demonstrably still moving is not a host that failed to start.
   *
   * Deliberately a plain timestamp rather than a "provisioning in flight"
   * boolean. A lane that hangs without emitting anything must still time out,
   * and only a per-event stamp distinguishes progress from a wedged lane.
   */
  notifyProvisioningActivity(): void {
    if (this.disposed) return;
    this.lastProvisioningActivityAt = Date.now();
  }

  /**
   * Path to the pid-metadata file this lifecycle is bound to. Exposed
   * so the SMAppService respawn handler can drive its own
   * `waitForHostReady` poll against the same on-disk source of truth
   * the watcher reads from. Read-only - callers MUST NOT write through
   * this path; pid.json writes are owned by the host process.
   */
  get pidMetadataFile(): string {
    return this.options.layout.pidMetadataFile;
  }

  /**
   * The host's durable enrollment record. Read-only, and unlike `pid.json` it
   * outlives the host process - which is what makes it answerable while the
   * host is stopped.
   */
  get identityEnrollmentFile(): string {
    return this.options.layout.identityEnrollmentFile;
  }

  /**
   * Whether this lifecycle has been torn down. Exposed so the
   * SMAppService respawn path can short-circuit between awaits without
   * driving real OS mutations against an already-disposed instance.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Force a fresh read of pid.json and emit `change` if it differs.
   *
   * The fs.watch-based watcher is the steady-state mechanism for
   * picking up host-state changes, but macOS FSEvents coalesces and
   * can drop the create event when pid.json is replaced quickly. The
   * SMAppService respawn handler calls this after `waitForHostReady`
   * resolves so the renderer's snapshot is guaranteed populated on
   * return - the original `respawn()` path got the same guarantee
   * implicitly via its private `waitForReady` + watcher seed.
   */
  reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return this.reloadSnapshot();
  }

  /**
   * Idempotent (re-)install of the pid-metadata watcher. Safe to call
   * after the watcher has been silently torn down (eg. an FSEvents
   * stream reset that the error handler logged but couldn't recover).
   * The internal `installWatcher` short-circuits if it still believes a
   * watcher is alive; force-resetting here lets the caller recover from
   * the rare wedged-watcher state.
   */
  ensureWatcherInstalled(): void {
    if (this.disposed) return;
    if (this.watcher !== null) {
      // Idempotent path: trust the existing watcher. We deliberately
      // don't tear it down on every respawn - the steady-state cost of
      // re-creating it on macOS is non-trivial (FSEvents subscription)
      // and the watcher rarely actually dies.
      return;
    }
    this.installWatcher();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.reachabilityRetryTimer !== null) {
      clearTimeout(this.reachabilityRetryTimer);
      this.reachabilityRetryTimer = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    // Detached host policy: we do NOT stop the service here. The OS
    // service manager owns the host's lifetime so other clients
    // (mobile, CLI) keep their local RPC endpoint when the desktop quits.
    // Lifecycle-level `dispose()` only tears down shell-side observers.
  }

  getRecentLogTail(maxLines: number): Promise<string | null> {
    return safeReadLogTail(this.options.layout.logFile, maxLines);
  }

  /**
   * Cheap predicate for the already-filtered `currentSnapshot`. Reachability,
   * websocket URL shape, and reachability checks happen in `reloadSnapshot()`
   * before a value is accepted into `currentSnapshot`; readiness loops always
   * call that probe path before consulting this predicate.
   */
  private isCompatible(snapshot: DesktopPublishedHostSnapshot | null): boolean {
    // A `busy` snapshot counts as compatible: the host EXISTS and is bindable,
    // which is the entire question every caller of this predicate is asking.
    // Requiring `available` here would put the readiness wait back on the
    // probe's coin toss - the fragility this ticket exists to remove.
    return snapshot !== null;
  }

  private async reloadSnapshot(): Promise<DesktopPublishedHostSnapshot | null> {
    if (this.disposed) {
      return this.currentSnapshot;
    }
    const generation = this.reloadGeneration + 1;
    this.reloadGeneration = generation;
    const readState = await readPidMetadataState(
      this.options.layout.pidMetadataFile,
    );
    if (readState.kind === "indeterminate") {
      // A FAILURE TO OBSERVE, not evidence of death. `readPidMetadataState`
      // separates the two precisely so this branch can exist: a transient
      // EACCES/EIO, or a read that landed mid-write, says nothing about the
      // host. Folding it as `absent` would have run it through the one arm with
      // no hysteresis at all (`host-availability-state.ts`: "absent is POSITIVE
      // evidence, not a failure to observe") and momentarily published a live
      // host as dead - and partial writes and I/O errors cluster with exactly
      // the load that makes a host slow to answer in the first place.
      //
      // So the previous verdict is HELD - no fold, no emit - and the ladder is
      // armed, which is what makes the hold temporary: the next read either
      // parses (and decides normally) or confirms ENOENT (and folds absent
      // then). Only the winning reload may arm; a superseded one must not move
      // shared state.
      if (!this.disposed && generation === this.reloadGeneration) {
        this.scheduleReachabilityRetry();
      }
      return this.currentSnapshot;
    }
    const raw = readState.kind === "parsed" ? readState.snapshot : null;
    const startIdentity =
      readState.kind === "parsed" ? readState.startIdentity : null;
    const presence = await this.readPresence(raw, startIdentity);
    // Superseded by a newer reload (or disposed): skip BOTH the fold and the
    // emit so we never clobber newer state, but still RETURN what THIS read
    // derived. A caller awaiting us - the host-busy surfacing in
    // host-ensure-ipc - must judge off this freshly-derived value, not a
    // `getSnapshot()` that a concurrent winning reload may not have assigned
    // yet (which would falsely read null and route a busy host to a restart).
    // The fold is skipped rather than applied-and-discarded because it is
    // ORDER-DEPENDENT: letting a losing read advance the hysteresis counter
    // would let two racing reloads demote on what is really one failure.
    if (this.disposed || generation !== this.reloadGeneration) {
      return raw === null ? null : unfoldedSnapshot(raw, presence);
    }
    this.availability = foldHostAvailability(this.availability, presence);
    const next = await this.toPublishedSnapshot(raw, this.availability);
    const prev = this.currentSnapshot;
    if (!snapshotEquals(prev, next)) {
      if (next === null && raw !== null) {
        log.info(
          "[host] ignoring pid metadata until the local host is reachable",
          {
            hostId: raw.hostId,
            websocketUrl: raw.websocketUrl,
            running: raw.version,
          },
        );
      } else if (next !== null && prev?.availability !== next.availability) {
        log.info("[host] local host availability changed", {
          hostId: next.hostId,
          pid: next.pid,
          from: prev?.availability ?? null,
          to: next.availability,
        });
      }
      this.currentSnapshot = next;
      this.emit("change", next);
    }
    // Retry-until-reachable. Two states need the ladder, and only one of them
    // used to:
    //   - no snapshot while the file PARSED (a named-but-unreachable host), and
    //   - a DEGRADED verdict, which now includes both the published `busy`
    //     state and the hysteresis hold that is still publishing `available`.
    // The watcher won't fire again until the FILE changes, so without a timer
    // either state is terminal for the session. The ladder is cleared only on a
    // CONFIRMED-absent file (a deliberate stop) with nothing degraded - a read
    // that failed rather than answered never gets here at all, having already
    // held and re-armed above.
    if (
      needsReprobe(this.availability) ||
      (readState.kind === "parsed" && next === null)
    ) {
      this.scheduleReachabilityRetry();
    } else {
      this.clearReachabilityRetry();
    }
    return next;
  }

  /**
   * The presence question, asked once per reload. Split out so the fold above
   * reads as policy and this reads as evidence-gathering.
   */
  private readPresence(
    raw: DesktopLocalHostSnapshot | null,
    startIdentity: ProcessStartIdentity | null,
  ): Promise<PublishedHostPresence> {
    if (raw === null) return Promise.resolve("absent");
    const probe = this.options.reachabilityProbe ?? canReachHostWebsocketUrl;
    return readPublishedHostPresence(
      raw.websocketUrl,
      raw.pid,
      startIdentity,
      probe,
      this.readIdentityVerdict,
    );
  }

  /**
   * The identity verdict, re-read at most once per
   * {@link IDENTITY_VERDICT_REUSE_MS} while the endpoint is silent. A bound
   * method rather than a closure per call so the cache is per lifecycle, which
   * is also the scope the ladder runs at.
   */
  private readonly readIdentityVerdict = async (
    query: PublishedProcessIdentityQuery,
  ): Promise<PublishedProcessIdentityVerdict> => {
    const cached = this.identityVerdictCache;
    if (
      !query.answered &&
      cached !== null &&
      cached.pid === query.pid &&
      Date.now() - cached.readAt < IDENTITY_VERDICT_REUSE_MS
    ) {
      return cached.verdict;
    }
    const verdict = await getPublishedProcessIdentityVerdict(
      query.pid,
      query.startIdentity,
    );
    // Death verdicts are not retained - see IDENTITY_VERDICT_REUSE_MS.
    this.identityVerdictCache =
      verdict === "dead" || verdict === "mismatch"
        ? null
        : { pid: query.pid, verdict, readAt: Date.now() };
    return verdict;
  };

  private scheduleReachabilityRetry(): void {
    if (this.disposed || this.reachabilityRetryTimer !== null) {
      return;
    }
    const delayMs = this.reachabilityRetryDelayMs;
    if (delayMs === REACHABILITY_RETRY_INITIAL_MS) {
      log.info(
        "[host] pid metadata present but endpoint unreachable - retrying until it answers",
        { delayMs },
      );
    }
    this.reachabilityRetryDelayMs = Math.min(
      delayMs * 2,
      REACHABILITY_RETRY_MAX_MS,
    );
    const timer = setTimeout(() => {
      this.reachabilityRetryTimer = null;
      void this.reloadSnapshot().catch((error: unknown) => {
        log.warn("[host] reachability retry reload failed", error);
      });
    }, delayMs);
    // The retry ladder must never be what keeps the main process alive.
    timer.unref();
    this.reachabilityRetryTimer = timer;
  }

  private clearReachabilityRetry(): void {
    this.reachabilityRetryDelayMs = REACHABILITY_RETRY_INITIAL_MS;
    if (this.reachabilityRetryTimer !== null) {
      clearTimeout(this.reachabilityRetryTimer);
      this.reachabilityRetryTimer = null;
    }
  }

  /**
   * Projects the folded verdict onto the renderer-facing snapshot. `null`
   * published verdict means "no host to bind to" and is the ONLY way this
   * class reports a dead host - a live-but-silent one comes back as `busy`
   * with its real `websocketUrl` intact, because the renderer's per-request
   * dials to that URL keep succeeding and taking it away is what cost the user
   * their session on 2026-08-11.
   */
  private async toPublishedSnapshot(
    raw: DesktopLocalHostSnapshot | null,
    availability: HostAvailabilityState,
  ): Promise<DesktopPublishedHostSnapshot | null> {
    if (raw === null || availability.published === null) {
      return null;
    }
    const named = await withConfiguredHostName(this.options.layout, raw);
    return { ...named, availability: availability.published };
  }

  private installWatcher(): void {
    if (this.watcher !== null) {
      return;
    }
    const targetBasename = basename(this.options.layout.pidMetadataFile);
    try {
      const watcher = watch(this.options.layout.rootDir, (_event, filename) => {
        if (filename === null) {
          this.reloadSnapshotFromWatcher();
          return;
        }
        if (typeof filename === "string" && filename === targetBasename) {
          this.reloadSnapshotFromWatcher();
        }
      });
      watcher.on("error", (err) => {
        // Null the reference so `ensureWatcherInstalled` (called from
        // the respawn path) can re-install. Without this, an FSEvents
        // stream-reset error leaves `this.watcher` non-null but inert
        // and the watcher is dead for the rest of the process lifetime.
        log.warn("[host] pid metadata watcher error", err);
        if (this.watcher === watcher) {
          this.watcher = null;
        }
      });
      this.watcher = watcher;
    } catch (err) {
      log.warn("[host] unable to install pid metadata watcher", err);
    }
  }

  /**
   * `fs.watch` needs the directory to already exist, and on a machine where
   * no host has ever been provisioned the CLI has not created the host root
   * yet - so `installWatcher` fails ENOENT and this lifecycle is left with NO
   * watcher for the rest of the session. Every fresh-install field report
   * carries that line (traycer#961, #996, #1001).
   *
   * It used to be partly self-correcting by accident: the readiness wait gave
   * a provisioning install time to create the root before the watcher was
   * installed at the end of it. Skipping that wait for a never-installed host
   * removes the accident, so the directory is created explicitly instead.
   * `HostController.publishReachableHostSnapshot` only re-arms the watcher on
   * converge paths that reach a live host - a converge that fails after
   * creating the root, or a host installed outside this controller, leaves
   * nothing to re-arm it.
   *
   * Creating it is safe: an empty root means nothing to the CLI (which
   * creates it recursively during install anyway), nothing infers install
   * state from its existence, and the desktop already does exactly this for
   * host name settings (`writeHostNameSettings`).
   *
   * Best-effort by design - a failure here must not become a startup error,
   * since `installWatcher` already degrades gracefully.
   */
  private async ensureWatchableRootDir(): Promise<void> {
    try {
      await mkdir(this.options.layout.rootDir, { recursive: true });
    } catch (err) {
      log.warn("[host] unable to create the host root directory to watch", err);
    }
  }

  private async waitForReady(): Promise<void> {
    const startedAt = Date.now();
    let extendedFrom: number | null = null;
    for (;;) {
      if (this.disposed) {
        return;
      }
      await this.reloadSnapshot();
      if (this.isCompatible(this.currentSnapshot)) {
        return;
      }
      // The budget runs from the last EVIDENCE that host provisioning is still
      // doing work, not from bootstrap. A fresh install can legitimately hold
      // this loop open for minutes while the CLI downloads and extracts the
      // runtime, and reporting "did not start" over a live installer is a
      // false failure the user cannot act on.
      const now = Date.now();
      const lastActivityAt = Math.max(
        startedAt,
        this.lastProvisioningActivityAt,
      );
      const quietMs = now - lastActivityAt;
      const waitedMs = now - startedAt;
      if (
        quietMs >= this.readyTimeoutMs ||
        waitedMs >= HOST_READY_MAX_WAIT_MS
      ) {
        throw new HostStartupException(
          "HOST_NOT_READY",
          `Traycer Host did not start within ${waitedMs}ms (${quietMs}ms with no installer progress) - run \`traycer host doctor\` to recover.`,
        );
      }
      if (extendedFrom === null && lastActivityAt > startedAt) {
        extendedFrom = lastActivityAt;
        log.info(
          "[host] extending the startup budget while host provisioning reports progress",
          {
            readyTimeoutMs: this.readyTimeoutMs,
            maxWaitMs: HOST_READY_MAX_WAIT_MS,
          },
        );
      }
      await sleep(HOST_POLL_INTERVAL_MS);
    }
  }

  private reloadSnapshotFromWatcher(): void {
    void this.reloadSnapshot().catch((error: unknown) => {
      log.warn(
        "[host] failed to reload pid metadata after watcher event",
        error,
      );
    });
  }

  private async buildStartupError(cause: unknown): Promise<HostStartupError> {
    const logTail = await safeReadLogTail(this.options.layout.logFile, 50);
    if (cause instanceof HostStartupException) {
      return { code: cause.code, message: cause.message, logTail };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return { code: "UNKNOWN", message, logTail };
  }
}

export function canReachHostWebsocketUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }

  const port =
    parsed.port === ""
      ? parsed.protocol === "wss:"
        ? 443
        : 80
      : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket =
      parsed.protocol === "wss:"
        ? createTlsConnection({
            host: parsed.hostname,
            port,
            // The host's loopback endpoint is authenticated by the
            // pid-record contract, not a public CA. TLS is still required
            // here: writing an HTTP upgrade before its handshake completes
            // would make a `wss://` host look unreachable.
            rejectUnauthorized: false,
          })
        : createConnection({
            host: parsed.hostname,
            port,
          });

    const settle = (reachable: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(HOST_ENDPOINT_CHECK_TIMEOUT_MS);
    let response = "";
    socket.once(
      parsed.protocol === "wss:" ? "secureConnect" : "connect",
      () => {
        socket.write(
          [
            `GET ${parsed.pathname} HTTP/1.1`,
            `Host: ${parsed.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      },
    );
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      const [statusLine = "", ...headerLines] = response.split("\r\n");
      const headers = headerLines
        .filter((line) => line.includes(":"))
        .map((line) => {
          const separator = line.indexOf(":");
          return [
            line.slice(0, separator).trim().toLowerCase(),
            line
              .slice(separator + 1)
              .trim()
              .toLowerCase(),
          ] as const;
        });
      const upgrade = headers.find(([name]) => name === "upgrade")?.[1];
      const connection = headers.find(([name]) => name === "connection")?.[1];
      const accept = headers.find(
        ([name]) => name === "sec-websocket-accept",
      )?.[1];
      settle(
        /^HTTP\/1\.1 101(?:\s|$)/.test(statusLine) &&
          upgrade === "websocket" &&
          connection?.includes("upgrade") === true &&
          typeof accept === "string" &&
          accept.length > 0,
      );
    });
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * The outcome of reading pid.json, kept DISTINCT so the reachability ladder can
 * tell "the host deliberately stopped" (file gone) from "I couldn't read it
 * yet" (a partial write, or a transient EACCES/EIO). Collapsing both to `null`
 * made a coalesced watcher edge that landed mid-write CLEAR the retry ladder,
 * so the original session-long wedge could persist (review finding 4). The host
 * writer documents partial reads as expected-and-retryable, so this is a real
 * interleaving, not a theoretical one.
 */
type PidMetadataRead =
  | {
      readonly kind: "parsed";
      readonly snapshot: DesktopLocalHostSnapshot;
      readonly startedAt: string | null;
      /**
       * The publishing process's kernel-recorded creation stamp, when the
       * host that wrote this file was new enough to publish one. `null` for
       * every `pid.json` written before the field existed - which readers
       * must treat as "cannot compare identity", never as a mismatch.
       */
      readonly startIdentity: ProcessStartIdentity | null;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate" };

export async function readPidMetadataState(
  path: string,
): Promise<PidMetadataRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    // ENOENT is the only signal that the host is genuinely gone; every other
    // read error (EACCES/EIO/EMFILE) leaves the file's fate unknown.
    if (isErrorCode(error, "ENOENT")) return { kind: "absent" };
    return { kind: "indeterminate" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A partially-written file parses as invalid JSON - present, not absent.
    return { kind: "indeterminate" };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { kind: "indeterminate" };
  }

  const obj = parsed as Record<string, unknown>;
  const hostId = obj.hostId;
  const websocketUrl = obj.websocketUrl;
  const version = obj.version;
  const pid = obj.pid;
  const startedAt = obj.startedAt;

  if (
    typeof hostId !== "string" ||
    typeof websocketUrl !== "string" ||
    typeof version !== "string" ||
    typeof pid !== "number"
  ) {
    return { kind: "indeterminate" };
  }

  return {
    kind: "parsed",
    snapshot: withDefaultHostName({ hostId, websocketUrl, version, pid }),
    startedAt: typeof startedAt === "string" ? startedAt : null,
    startIdentity: isProcessStartIdentity(obj.processStartIdentity)
      ? obj.processStartIdentity
      : null,
  };
}

export async function readPidMetadata(
  path: string,
): Promise<DesktopLocalHostSnapshot | null> {
  const state = await readPidMetadataState(path);
  return state.kind === "parsed" ? state.snapshot : null;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function safeReadLogTail(
  path: string,
  maxLines: number,
): Promise<string | null> {
  // Read directly and let the single catch handle every failure mode — a
  // missing file (ENOENT) and a path that's a directory (EISDIR) both land
  // here. A prior stat()/isFile() check would only add a TOCTOU window.
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

function snapshotEquals(
  a: DesktopPublishedHostSnapshot | null,
  b: DesktopPublishedHostSnapshot | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.hostId === b.hostId &&
    a.websocketUrl === b.websocketUrl &&
    a.version === b.version &&
    a.pid === b.pid &&
    a.systemHostName === b.systemHostName &&
    a.displayName === b.displayName &&
    // Availability is part of the identity of an emitted snapshot: an
    // available -> busy -> available round trip has to reach the renderer, or
    // the degraded badge would appear and never clear.
    a.availability === b.availability
  );
}

/**
 * The snapshot a SUPERSEDED reload returns to its own awaiting caller, derived
 * straight from that read's presence with no hysteresis applied. It is never
 * published; the winning reload owns what the renderer sees. Callers of
 * `reloadSnapshotFromDisk` only ask "is there a host on disk right now", which
 * this answers honestly without letting a losing read move shared state.
 */
function unfoldedSnapshot(
  raw: DesktopLocalHostSnapshot,
  presence: PublishedHostPresence,
): DesktopPublishedHostSnapshot | null {
  if (presence === "absent") return null;
  return { ...raw, availability: presence };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { PRODUCTION_LABEL };
export type { ServiceLabel };
