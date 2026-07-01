import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
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
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import { streamTraycerCliJson } from "../cli/traycer-cli";

/**
 * Snapshot of the OS-supervised host's runtime state, as projected by
 * `HostLifecycle.getServiceStatus`. Mirrors the wire shape consumed by the
 * renderer's Service Health pane.
 */
export interface ServiceStatus {
  readonly state: "running" | "stopped" | "not-installed";
  readonly version: string | null;
  readonly listenUrl: string | null;
  readonly pid: number | null;
}

/**
 * Committed WS-only endpoint path published by the bundled host.
 *
 * Mirrors the `WS_RPC_PATH` published by the host (the external
 * Traycer Host) - kept as a local constant because desktop-main is
 * CommonJS-isolated and must not import the host workspace. If the host
 * changes its path, update both sides.
 */
const WS_RPC_PATH = "/rpc";
const WS_RPC_HOST = "127.0.0.1";

/**
 * How long we wait for the OS-supervised host to publish its PID
 * metadata before surfacing a Doctor-recovery startup failure to the
 * renderer. The CLI supervisor (`traycer host start`) sources the
 * user's shell as part of bootstrap, so this needs to absorb the user's
 * full rc-file init cost. 60s is sized for slow oh-my-zsh setups +
 * Prisma/native init.
 */
const HOST_READY_TIMEOUT_MS = 60_000;
const HOST_POLL_INTERVAL_MS = 250;
const HOST_ENDPOINT_CHECK_TIMEOUT_MS = 750;
const CLI_RESTART_TIMEOUT_MS = 2 * 60_000;
const CLI_START_STOP_TIMEOUT_MS = 60_000;

export interface HostLifecycleEvents {
  change: (snapshot: DesktopLocalHostSnapshot | null) => void;
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
  private currentSnapshot: DesktopLocalHostSnapshot | null = null;
  private reloadGeneration = 0;
  private disposed = false;

  constructor(options: HostLifecycleOptions) {
    super();
    this.options = options;
    this.readyTimeoutMs =
      typeof options.readyTimeoutMs === "number"
        ? options.readyTimeoutMs
        : HOST_READY_TIMEOUT_MS;
  }

  getSnapshot(): DesktopLocalHostSnapshot | null {
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
   * CLI-owned (Tech Plan Decision 1).
   */
  async bootstrap(): Promise<void> {
    try {
      await this.reloadSnapshot();
      if (!this.isCompatible(this.currentSnapshot)) {
        await this.waitForReady();
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
   * Renderer-driven restart. The CLI is the host lifecycle authority, so
   * we shell out to `traycer host restart` (the slot is baked into the CLI
   * build) instead of poking the platform service-manager APIs directly. The
   * PID-file watcher fires `change` once the new host publishes fresh
   * metadata.
   */
  async respawn(): Promise<void> {
    if (this.disposed) {
      return;
    }
    log.info("[host] respawn requested");

    this.notifyRespawning();

    try {
      try {
        await this.cliHostRestart();
      } catch (cause) {
        throw new HostStartupException(
          "SERVICE_RESTART_FAILED",
          `traycer host restart failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      await this.waitForReady();
      this.installWatcher();
    } catch (cause) {
      const startupError = await this.buildStartupError(cause);
      log.error("[host] respawn failed", startupError);
      this.emit("error", startupError);
    }
  }

  /**
   * Mark the host as "currently down" from the renderer's perspective.
   *
   * Used by the macOS host-owned-login-item respawn path
   * (`app/host-respawn.ts`) so it can drive the SMAppService
   * re-register cycle itself without re-entering `respawn()`'s
   * CLI-restart codepath - but still keep the renderer's cached
   * snapshot consistent (cleared on respawn start, repopulated by the
   * existing pid-file watcher when the new host publishes pid.json).
   * On non-macOS / dev / non-login-item paths, callers go through
   * `respawn()`, which calls this internally.
   */
  notifyRespawning(): void {
    if (this.disposed) return;
    this.currentSnapshot = null;
    this.emit("change", null);
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
  reloadSnapshotFromDisk(): Promise<DesktopLocalHostSnapshot | null> {
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
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    // Detached host policy: we do NOT stop the service here. The OS
    // service manager owns the host's lifetime so other clients
    // (mobile, CLI) keep their local RPC endpoint when the desktop quits.
    // Lifecycle-level `dispose()` only tears down shell-side observers.
  }

  // -----------------------------------------------------------
  // Service-control passthroughs for the Service Health pane.
  //
  // All routes delegate to the CLI subprocess so Desktop never reaches
  // for the legacy platform service-manager dispatch (Tech Plan
  // Decision 1, Ticket 7c890b39). `getServiceStatus` is metadata-first:
  // a published `pid.json` is a running host; absence is presented to
  // the renderer as `not-installed` so the Doctor card surfaces.
  // -----------------------------------------------------------

  async getServiceStatus(): Promise<ServiceStatus> {
    const snapshot = await readPidMetadata(this.options.layout.pidMetadataFile);
    if (snapshot === null) {
      return {
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      };
    }
    return {
      state: "running",
      version: snapshot.version,
      listenUrl: snapshot.websocketUrl,
      pid: snapshot.pid,
    };
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
  private isCompatible(snapshot: DesktopLocalHostSnapshot | null): boolean {
    return snapshot !== null;
  }

  private async reloadSnapshot(): Promise<DesktopLocalHostSnapshot | null> {
    if (this.disposed) {
      return this.currentSnapshot;
    }
    const generation = this.reloadGeneration + 1;
    this.reloadGeneration = generation;
    const raw = await readPidMetadata(this.options.layout.pidMetadataFile);
    // Filter an unreachable / wrong-shaped host out of what the renderer sees,
    // so the host gate treats it as not-ready and fires `ensureHost`. A
    // reachable host is surfaced regardless of its version stamp - the renderer
    // negotiates protocol compatibility over the WS handshake and prompts for a
    // restart only if the running host is genuinely incompatible.
    const next = await this.toReachableSnapshot(raw);
    // Superseded by a newer reload (or disposed): skip the emit so we never
    // clobber newer state, but still RETURN what THIS read derived. A caller
    // awaiting us - the host-busy surfacing in host-ensure-ipc - must judge
    // off this freshly-derived value, not a `getSnapshot()` that a concurrent
    // winning reload may not have assigned yet (which would falsely read null
    // and route a busy host to a restart).
    if (this.disposed || generation !== this.reloadGeneration) {
      return next;
    }
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
      }
      this.currentSnapshot = next;
      this.emit("change", next);
    }
    return next;
  }

  private async toReachableSnapshot(
    raw: DesktopLocalHostSnapshot | null,
  ): Promise<DesktopLocalHostSnapshot | null> {
    if (raw === null) {
      return null;
    }
    if (!isCurrentHostWebsocketUrl(raw.websocketUrl)) {
      return null;
    }
    const probe = this.options.reachabilityProbe ?? canReachHostWebsocketUrl;
    if (!(await probe(raw.websocketUrl))) {
      return null;
    }
    return withConfiguredHostName(this.options.layout, raw);
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

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.disposed) {
        return;
      }
      await this.reloadSnapshot();
      if (this.isCompatible(this.currentSnapshot)) {
        return;
      }
      await sleep(HOST_POLL_INTERVAL_MS);
    }
    throw new HostStartupException(
      "HOST_NOT_READY",
      `Traycer Host did not start within ${this.readyTimeoutMs}ms - run \`traycer host doctor\` to recover.`,
    );
  }

  private reloadSnapshotFromWatcher(): void {
    void this.reloadSnapshot().catch((error: unknown) => {
      log.warn(
        "[host] failed to reload pid metadata after watcher event",
        error,
      );
    });
  }

  private async cliHostRestart(): Promise<void> {
    // The CLI resolves its slot from `config.environment` (baked per build),
    // so no channel arg is passed.
    await streamTraycerCliJson<unknown>({
      args: ["host", "restart"],
      env: null,
      timeoutMs: CLI_RESTART_TIMEOUT_MS,
      onEvent: () => {
        // No progress sink - restart payload is small and any partial
        // progress lines are advisory. The PID-metadata watcher fires
        // `change` once the new host publishes pid.json.
      },
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

/**
 * Returns `true` only when `url` matches the committed WS-only host
 * endpoint contract: `ws://127.0.0.1:<port>/rpc` (or the `wss://` variant).
 */
export function isCurrentHostWebsocketUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  if (parsed.hostname !== WS_RPC_HOST) {
    return false;
  }
  if (parsed.port === "") {
    return false;
  }
  return parsed.pathname === WS_RPC_PATH;
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
    const socket = createConnection({
      host: parsed.hostname,
      port,
    });

    const settle = (reachable: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(HOST_ENDPOINT_CHECK_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export async function readPidMetadata(
  path: string,
): Promise<DesktopLocalHostSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const hostId = obj.hostId;
  const websocketUrl = obj.websocketUrl;
  const version = obj.version;
  const pid = obj.pid;

  if (
    typeof hostId !== "string" ||
    typeof websocketUrl !== "string" ||
    typeof version !== "string" ||
    typeof pid !== "number"
  ) {
    return null;
  }

  return withDefaultHostName({ hostId, websocketUrl, version, pid });
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
  a: DesktopLocalHostSnapshot | null,
  b: DesktopLocalHostSnapshot | null,
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
    a.displayName === b.displayName
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { PRODUCTION_LABEL };
export type { ServiceLabel };
