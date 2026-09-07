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

const HOST_READY_TIMEOUT_MS = 60_000;
/** Ceiling on the total wait regardless of progress, so an installer that emits events forever can never hold bootstrap open indefinitely. */
const HOST_READY_MAX_WAIT_MS = 15 * 60_000;
const HOST_POLL_INTERVAL_MS = 250;
const HOST_ENDPOINT_CHECK_TIMEOUT_MS = 750;
const CLI_START_STOP_TIMEOUT_MS = 60_000;
const REACHABILITY_RETRY_INITIAL_MS = 250;
const REACHABILITY_RETRY_MAX_MS = 5_000;
/**
 * What is NOT throttled, and must not be: - a verdict read on a probe that ANSWERED.
 * Those are the two that decide DEATH (`readPublishedHostPresence` maps them to `absent`), and a positive death must never be served from a cache.
 */
const IDENTITY_VERDICT_REUSE_MS = 120_000;

export interface HostLifecycleEvents {
  change: (snapshot: DesktopPublishedHostSnapshot | null) => void;
  error: (error: HostStartupError) => void;
}

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
  readonly bundledBinaryPath: string | null;
  /** The two must agree - the environment of `label` is selected at the boot seam in `main-process.ts` and threaded into both `layout` and the CLI subprocess calls. */
  readonly label: ServiceLabel;
  readonly readyTimeoutMs: number | undefined;
  readonly reachabilityProbe:
    | ((websocketUrl: string) => Promise<boolean>)
    | undefined;
}

/** The class stays transport-agnostic - it never opens the host's WebSocket endpoint. */
export class HostLifecycle extends EventEmitter {
  private readonly options: HostLifecycleOptions;
  private readonly readyTimeoutMs: number;
  private watcher: FSWatcher | null = null;
  private currentSnapshot: DesktopPublishedHostSnapshot | null = null;
  private availability: HostAvailabilityState = INITIAL_HOST_AVAILABILITY_STATE;
  /** Coalesces out-of-band repair reloads onto one in-flight read. */
  private repairInFlight = false;
  private reloadGeneration = 0;
  private disposed = false;
  private reachabilityRetryTimer: NodeJS.Timeout | null = null;
  private reachabilityRetryDelayMs = REACHABILITY_RETRY_INITIAL_MS;
  private identityVerdictCache: {
    readonly pid: number;
    readonly verdict: PublishedProcessIdentityVerdict;
    readonly readAt: number;
  } | null = null;
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
   * Metadata-first boot (Ticket 7c890b39): - read the environment-scoped pid metadata file - if it's well-formed and the websocket URL is reachable, emit a `LocalHostSnapshot`.
   * Install / upgrade / register-service actions are all CLI-owned (Tech Plan Decision 1). `hostInstalled` is therefore handed IN by the caller rather than read here.
   */
  async bootstrap(options: { readonly hostInstalled: boolean }): Promise<void> {
    // Ahead of BOTH watcher installs below - the success path and the catch.
    await this.ensureWatchableRootDir();
    try {
      await this.reloadSnapshot();
      if (!this.isCompatible(this.currentSnapshot)) {
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
      this.installWatcher();
      const startupError = await this.buildStartupError(cause);
      log.error("[host] startup failed", startupError);
      this.emit("error", startupError);
    }
  }

  notifyRespawning(): void {
    if (this.disposed) return;
    this.currentSnapshot = null;
    this.availability = INITIAL_HOST_AVAILABILITY_STATE;
    this.emit("change", null);
    // The replacement host is a different process, so nothing the last one
    // proved about its identity applies to it.
    this.identityVerdictCache = null;
    this.clearReachabilityRetry();
    this.scheduleReachabilityRetry();
  }

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

  /** A lane that hangs without emitting anything must still time out, and only a per-event stamp distinguishes progress from a wedged lane. */
  notifyProvisioningActivity(): void {
    if (this.disposed) return;
    this.lastProvisioningActivityAt = Date.now();
  }

  /** Read-only - callers MUST NOT write through this path; pid.json writes are owned by the host process. */
  get pidMetadataFile(): string {
    return this.options.layout.pidMetadataFile;
  }

  get identityEnrollmentFile(): string {
    return this.options.layout.identityEnrollmentFile;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return this.reloadSnapshot();
  }

  /**
   * Safe to call after the watcher has been silently torn down (eg.
   * The internal `installWatcher` short-circuits if it still believes a watcher is alive; force-resetting here lets the caller recover from the rare wedged-watcher state.
   */
  ensureWatcherInstalled(): void {
    if (this.disposed) return;
    if (this.watcher !== null) {
      // We deliberately don't tear it down on every respawn - the steady-state cost of re-creating it on macOS is non-trivial (FSEvents subscription) and the watcher rarely actually dies.
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
    // Detached host policy: we do NOT stop the service here.
  }

  getRecentLogTail(maxLines: number): Promise<string | null> {
    return safeReadLogTail(this.options.layout.logFile, maxLines);
  }

  private isCompatible(snapshot: DesktopPublishedHostSnapshot | null): boolean {
    // A `busy` snapshot counts as compatible: the host EXISTS and is bindable, which is the entire question every caller of this predicate is asking.
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
      // Only the winning reload may arm; a superseded one must not move shared state.
      if (!this.disposed && generation === this.reloadGeneration) {
        this.scheduleReachabilityRetry();
      }
      return this.currentSnapshot;
    }
    const raw = readState.kind === "parsed" ? readState.snapshot : null;
    const startIdentity =
      readState.kind === "parsed" ? readState.startIdentity : null;
    const presence = await this.readPresence(raw, startIdentity);
    // Superseded by a newer reload (or disposed): skip BOTH the fold and the emit so we never clobber newer state, but still RETURN what THIS read derived.
    // A caller awaiting us - the host-busy surfacing in host-ensure-ipc.
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

  private readonly readIdentityVerdict = async (
    query: PublishedProcessIdentityQuery,
  ): Promise<PublishedProcessIdentityVerdict> => {
    const cached = this.identityVerdictCache;
    // Only ALIVE verdicts are cached (death verdicts are not retained), so the reuse age must be nonnegative before it can satisfy the TTL: a backward clock step makes it negative.
    if (!query.answered && cached !== null && cached.pid === query.pid) {
      const reuseAgeMs = Date.now() - cached.readAt;
      if (reuseAgeMs >= 0 && reuseAgeMs < IDENTITY_VERDICT_REUSE_MS) {
        return cached.verdict;
      }
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
   * It used to be partly self-correcting by accident: the readiness wait gave a provisioning install time to create the root before the watcher was installed at the end of it.
   * Best-effort by design - a failure here must not become a startup error, since `installWatcher` already degrades gracefully.
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

type PidMetadataRead =
  | {
      readonly kind: "parsed";
      readonly snapshot: DesktopLocalHostSnapshot;
      readonly startedAt: string | null;
      /** `null` for every `pid.json` written before the field existed - which readers must treat as "cannot compare identity", never as a mismatch. */
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
  // Read directly and let the single catch handle every failure mode  -  a
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

/** It is never published; the winning reload owns what the renderer sees. */
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
