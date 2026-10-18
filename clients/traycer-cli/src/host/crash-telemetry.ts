import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  arch as osArch,
  platform as osPlatform,
  release as osRelease,
} from "node:os";
import * as Sentry from "@sentry/node";
import { resolveCliVersion } from "../cli-version";
import type { Environment } from "../runner/environment";
import { destroySentryTransportRequests } from "../sentry-transport";
import { hostCrashThrottlePath } from "../store/paths";
import {
  isWindowsExternalTerminationExit,
  type CrashReportMemory,
  type StderrFatalKind,
} from "./crash-diagnostics";
import { readHostPidMetadata } from "./pid-metadata";

// Fleet visibility for host crashes.
//
// The supervisor already leaves one line of evidence per crash in host.log
// (`phase=crashed code=… exitMeaning=…`), and that line is what a support
// pull reads. But it stays on the machine: a Windows fast-fail that restarts
// the host within a second is invisible to everyone but the user who
// happens to look, and the 2026-09 `0xC0000409` investigation (libuv's
// uninitialized OSVERSIONINFOW, Node < 24.16.0) found the defect on ONE
// reporter's host while every Windows install carried it. This module sends
// the same fact to Sentry so the next one is countable across hosts.
//
// What goes out, and what deliberately does not:
//   - The identity is the HOST id (read from the host's own pid.json), never
//     an account, email or user id. It rides in Sentry's `user.id` slot so
//     the issue's "users" column counts distinct hosts, which is the only
//     question this exists to answer.
//   - The decoded exit status, the signal, the host version, the OS release
//     and how long the child ran. All of it is already in host.log.
//   - NOT the stderr tail (it can carry prompt text and paths), NOT the
//     bundle path (it contains the user's home directory), NOT the
//     diagnostic-report contents - only whether one exists.
//
// Every step is best-effort and bounded by the caller: the terminal marker is
// readiness authority and is written first; nothing here may delay or
// replace it.

/** What the supervisor knows about a crash at the moment it writes the marker. */
export interface HostCrashTelemetry {
  readonly environment: Environment;
  readonly attemptId: string;
  readonly supervisorPid: number;
  /**
   * The crashed child's pid, `null` if the spawn never yielded one. Used to
   * decide whether the pid.json on disk was written by THIS child.
   */
  readonly childPid: number | null;
  /** Version from the install record the supervisor spawned. */
  readonly hostVersion: string;
  /** Positive decimal exit status, `null` when the child died by signal. */
  readonly exitCode: number | null;
  /** The fatal signal, `null` for an exit-status death. */
  readonly signal: string | null;
  /** Decoded meaning (see `crash-diagnostics.ts`), `null` when unknown. */
  readonly exitMeaning: string | null;
  /** Whether the child left a Node diagnostic report. */
  readonly hasDiagnosticReport: boolean;
  /** Wall-clock lifetime of the child, spawn to exit. */
  readonly uptimeMs: number;
  /**
   * Whether a stop was asked for when the child ended (the shutdown latch, or
   * a stop intent the supervisor read). Only the verdict: the intent itself
   * is not carried.
   */
  readonly stopRequested: boolean;
  /** Whether the child wrote nothing at all to stderr. Only the verdict. */
  readonly stderrEmpty: boolean;
  /**
   * Which kind of fatal the stderr capture holds. Only the closed-set verdict
   * (`crash-diagnostics.ts`): never the text, which stays on the machine.
   */
  readonly stderrFatal: StderrFatalKind;
  /**
   * The memory numbers the diagnostic report states, in bytes; a field is
   * `null` when there was no report or the report did not carry it.
   */
  readonly reportMemory: CrashReportMemory;
}

/** The host's own identity, read from pid.json after the crash. */
export interface HostCrashIdentity {
  readonly hostId: string;
  /**
   * The version the crashed child itself published, `null` when the pid.json
   * on disk was written by a different process (an earlier child that died
   * before this one could publish, possibly from a different install), in
   * which case attributing its version to this crash would be wrong.
   */
  readonly runningVersion: string | null;
}

/**
 * The Sentry event, assembled without touching Sentry so it can be asserted
 * on directly. Kept flat and typed rather than passed through `Sentry.Event`
 * so the field set is reviewable here, in one place.
 */
export interface HostCrashEvent {
  readonly message: string;
  /** `error` for a crash; `warning` for an exit that is not one. */
  readonly level: "error" | "warning";
  readonly fingerprint: readonly string[];
  readonly hostId: string | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, string | number | boolean>>;
}

export const HOST_CRASH_FINGERPRINT_ROOT = "host-crash";

/**
 * What the pid.json on disk says about the crashed child: `published` - the
 * file's pid is the child's pid; `before-publish` - a file exists with another
 * pid; `unknown` - no readable file, or the spawn yielded no pid to compare.
 * It is evidence about publishing, not a verdict on how far startup got.
 */
export type HostCrashPhase = "published" | "before-publish" | "unknown";

export function hostCrashPhase(
  identity: HostCrashIdentity | null,
  childPid: number | null,
): HostCrashPhase {
  if (identity === null || childPid === null) return "unknown";
  return identity.runningVersion !== null ? "published" : "before-publish";
}

/**
 * A closed set of lifetimes, so "exits within seconds of spawn" and "ran for
 * a day" are separate groups in the issue's tag view instead of one number.
 */
export type UptimeBucket =
  | "lt-10s"
  | "lt-1m"
  | "lt-10m"
  | "lt-1h"
  | "lt-24h"
  | "gte-24h";

export function uptimeBucket(uptimeMs: number): UptimeBucket {
  if (uptimeMs < 10_000) return "lt-10s";
  if (uptimeMs < 60_000) return "lt-1m";
  if (uptimeMs < 10 * 60_000) return "lt-10m";
  if (uptimeMs < 60 * 60_000) return "lt-1h";
  if (uptimeMs < 24 * 60 * 60_000) return "lt-24h";
  return "gte-24h";
}

// The identity read is a single small file, but it is on the exit path of a
// supervisor that may be about to relaunch, so it gets the same treatment as
// the crash-report scan: a budget, and `null` past it.
export const HOST_CRASH_IDENTITY_TIMEOUT_MS = 1_000;

// The supervisor's outer bound on the whole report (identity read plus the
// synchronous capture). Above the identity budget so that budget is the one
// that normally fires; far below the relaunch backoff so a stall costs
// nothing visible.
export const HOST_CRASH_REPORT_TIMEOUT_MS = 1_500;

// How long the queued envelope may take to actually leave the machine. The
// CLI's Sentry transport installs no request timeout (see
// sentry-transport.ts), and `host start` deliberately bypasses the
// terminator in runner/exit.ts that would otherwise destroy stalled requests
// at exit - the supervisor does not exit, it relaunches. So a DSN endpoint
// that accepts the connection and then goes quiet would leave one live
// socket per crash for as long as the supervisor lives. This budget is
// generous enough for a slow but working upload and retires whatever is
// still open past it.
export const HOST_CRASH_TRANSPORT_TIMEOUT_MS = 10_000;

/**
 * A stable token for the KIND of death, used to group events into one issue
 * per (platform, cause): every Windows `0xC0000409` lands together, every
 * Linux SIGKILL lands together. Hex for high-bit NTSTATUS codes so the token
 * matches the decoded meaning a reader sees in host.log.
 */
export function crashKindToken(
  exitCode: number | null,
  signal: string | null,
): string {
  if (signal !== null) return signal;
  if (exitCode === null) return "unknown";
  return exitCode > 0xffff
    ? `0x${exitCode.toString(16).toUpperCase()}`
    : String(exitCode);
}

export function buildHostCrashEvent(
  telemetry: HostCrashTelemetry,
  identity: HostCrashIdentity | null,
): HostCrashEvent {
  const platform = osPlatform();
  const kind = crashKindToken(telemetry.exitCode, telemetry.signal);
  const cause = telemetry.exitMeaning ?? kind;
  // Ended from outside (not a crash, not proven to be a session end): kept
  // queryable at a lower severity and under its own fingerprint, so a rise in
  // mid-session kills is visible without being a crash issue.
  // (A POSIX exit status never exceeds 255, so the code alone is Windows.)
  const externallyTerminated =
    telemetry.exitCode !== null &&
    isWindowsExternalTerminationExit(telemetry.exitCode);
  return {
    message: externallyTerminated
      ? `Host terminated externally: ${cause}`
      : `Host crashed: ${cause}`,
    level: externallyTerminated ? "warning" : "error",
    fingerprint: [
      HOST_CRASH_FINGERPRINT_ROOT,
      platform,
      externallyTerminated ? "external-termination" : kind,
    ],
    hostId: identity?.hostId ?? null,
    tags: {
      host_environment: telemetry.environment,
      host_version: telemetry.hostVersion,
      host_running_version: identity?.runningVersion ?? "unknown",
      // The release-injected CLI version (`cli-version.ts`), not
      // `config.version`: the published CLI artifacts stamp only the former,
      // and the deploy-target build stamp stays at its source sentinel there.
      cli_version: resolveCliVersion(process.env),
      platform,
      arch: osArch(),
      os_release: osRelease(),
      crash_kind: kind,
      ...(externallyTerminated
        ? { host_exit_kind: "external-termination" }
        : {}),
      // The tags below split one exit status into its causes: a stop
      // that was asked for, a child that never got as far as publishing, one
      // that said nothing before dying, and how long it ran. Closed sets, so
      // none can carry a path, a message or an id.
      stop_requested: telemetry.stopRequested ? "yes" : "no",
      host_output: telemetry.stderrEmpty ? "silent" : "wrote",
      // Which kind of fatal that output was (a heap OOM, another V8 fatal, a
      // CHECK block, a native assertion, ...): the closed set that splits one
      // exit status, 0xC0000409 above all, into its causes.
      host_fatal: telemetry.stderrFatal,
      host_phase: hostCrashPhase(identity, telemetry.childPid),
      uptime_bucket: uptimeBucket(telemetry.uptimeMs),
    },
    extra: {
      attemptId: telemetry.attemptId,
      supervisorPid: telemetry.supervisorPid,
      childPid: telemetry.childPid ?? -1,
      exitCode: telemetry.exitCode ?? -1,
      signal: telemetry.signal ?? "",
      exitMeaning: telemetry.exitMeaning ?? "",
      hasDiagnosticReport: telemetry.hasDiagnosticReport,
      uptimeMs: telemetry.uptimeMs,
      hostIdKnown: identity !== null,
      // Plain counters, present only when the report stated them: a missing
      // reading is absent, never a 0 or -1 that reads as a measurement.
      ...(telemetry.reportMemory.heapLimitBytes === null
        ? {}
        : { heapLimitBytes: telemetry.reportMemory.heapLimitBytes }),
      ...(telemetry.reportMemory.heapUsedBytes === null
        ? {}
        : { heapUsedBytes: telemetry.reportMemory.heapUsedBytes }),
      ...(telemetry.reportMemory.rssBytes === null
        ? {}
        : { rssBytes: telemetry.reportMemory.rssBytes }),
    },
  };
}

/**
 * Read the host id from the pid.json the crashed host wrote. On a crash the
 * file survives (only a graceful shutdown removes it), and the host id is a
 * property of the host home rather than of the process, so a stale file from
 * an earlier child still names the right host. The VERSION is per process,
 * though: it is attributed to this crash only when the file's pid is the
 * crashed child's, so a child that died before publishing (possibly from a
 * different install than the file's author) reports its version as unknown
 * rather than borrowing its predecessor's.
 */
export async function readHostCrashIdentity(
  environment: Environment,
  childPid: number | null,
): Promise<HostCrashIdentity | null> {
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) return null;
  const writtenByThisChild = childPid !== null && metadata.pid === childPid;
  return {
    hostId: metadata.hostId,
    runningVersion: writtenByThisChild ? metadata.version : null,
  };
}

/**
 * Send one crash event. `Sentry.captureMessage` only queues; the transport
 * sends in the background while the supervisor backs off and relaunches, so
 * this never waits on the network. When no DSN was baked in (dev builds),
 * every Sentry call is a no-op.
 */
export function captureHostCrashEvent(event: HostCrashEvent): void {
  Sentry.withScope((scope) => {
    scope.setLevel(event.level);
    scope.setFingerprint([...event.fingerprint]);
    scope.setTags(event.tags);
    scope.setExtras(event.extra);
    if (event.hostId !== null) {
      // The host id, not a person: it is what makes the issue's "users"
      // column count distinct hosts.
      scope.setUser({ id: event.hostId });
    }
    Sentry.captureMessage(event.message, event.level);
  });
}

/**
 * The count for a run of crashes {@link HostCrashReportThrottle} held back.
 * A `warning`, under its own fingerprint, so the run is one line beside the
 * issue it belongs to rather than more events inside it.
 */
export function captureHostCrashSummary(
  event: HostCrashEvent,
  suppressedCount: number,
  windowStartedAt: number,
): void {
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setFingerprint([...event.fingerprint, "repeated"]);
    scope.setTags(event.tags);
    scope.setExtras({ suppressedCount, windowStartedAt });
    if (event.hostId !== null) {
      scope.setUser({ id: event.hostId });
    }
    Sentry.captureMessage(`${event.message} (repeated)`, "warning");
  });
}

/** The most kinds the throttle keeps on disk. */
const MAX_PERSISTED_KINDS = 32;

/** Crashes of one kind reported in full before the throttle starts counting. */
export const HOST_CRASH_REPORTS_BEFORE_THROTTLE = 3;

/**
 * How long a counting window runs before its summary is sent, and how long a
 * kind must stay quiet before it is reported in full again.
 */
export const HOST_CRASH_SUMMARY_WINDOW_MS = 60 * 60 * 1000;

export interface HostCrashReportThrottleDeps {
  readonly now: () => number;
  readonly capture: (event: HostCrashEvent) => void;
  readonly captureSummary: (
    event: HostCrashEvent,
    suppressedCount: number,
    windowStartedAt: number,
  ) => void;
  /** Runs `callback` once after `delayMs`; must not keep the process alive. */
  readonly schedule: (callback: () => void, delayMs: number) => void;
  /**
   * Called with the whole state after every change, so a later supervisor
   * process can pick it up (see {@link HostCrashReportThrottle.restore}).
   * Best-effort: a throw is swallowed and the in-memory state carries on.
   */
  readonly persist: (state: PersistedHostCrashThrottle) => void;
}

/**
 * The part of a held-back crash a summary is sent from. Deliberately not the
 * whole {@link HostCrashEvent}: no `extra` (attempt id, pids, memory), which
 * the summary does not carry and which has no business in a state file.
 */
export interface PersistedHostCrashEvent {
  readonly message: string;
  readonly level: "error" | "warning";
  readonly fingerprint: readonly string[];
  readonly hostId: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

/** One kind's throttle state as it is kept on disk. */
export interface PersistedHostCrashKind {
  readonly reported: number;
  readonly lastCrashAt: number;
  readonly suppressedCount: number;
  readonly windowStartedAt: number;
  readonly lastSuppressed: PersistedHostCrashEvent | null;
}

/** Throttle state by fingerprint key, as written to and read from disk. */
export type PersistedHostCrashThrottle = ReadonlyMap<
  string,
  PersistedHostCrashKind
>;

interface HostCrashThrottleState {
  /** Full reports sent; only a capture that returned counts. */
  reported: number;
  lastCrashAt: number;
  /** Crashes held back since the last summary was sent. */
  suppressedCount: number;
  /** The most recent held-back crash, which the summary is sent as. */
  lastSuppressed: HostCrashEvent | null;
  /** When the first crash of the open window was held back. */
  windowStartedAt: number;
}

/**
 * Bounds what one crash-looping host can report.
 *
 * The supervisor relaunches a crashed host and reports each crash. A host that
 * cannot start crashes on every relaunch, for as long as the machine is on:
 * one such host reported 7,023 crashes in four days. What those events say is
 * carried by the first few and by how many followed, so that is what is sent:
 * the first {@link HOST_CRASH_REPORTS_BEFORE_THROTTLE} crashes of a kind in
 * full, then a count. The first held-back crash opens a window of
 * {@link HOST_CRASH_SUMMARY_WINDOW_MS}, and when it ends one summary carries
 * how many were held back in it, whether or not the host is still crashing.
 * A kind that then stays quiet for a whole window is reported in full again
 * on its next crash.
 *
 * Keyed by the event's fingerprint, the same (platform, kind) pair that groups
 * the issue, so a host that starts dying a different way is reported in full
 * again.
 *
 * The bound has to hold across supervisor processes. The supervisor gives up
 * after a few consecutive relaunches and exits, and the service manager
 * (systemd, launchd) starts a new one; a host that can never start therefore
 * lives through many supervisors, and state kept in one of them gave each a
 * fresh budget of full reports (one machine sent 18 to 84 an hour, every
 * hour). So every change is handed to {@link HostCrashReportThrottleDeps.persist}
 * and {@link restore} takes it back at the next supervisor's start: its
 * budgets carry over, and a count the previous supervisor left open is sent
 * when its window ends (at once, when it already has).
 */
export class HostCrashReportThrottle {
  private readonly deps: HostCrashReportThrottleDeps;
  private readonly states = new Map<string, HostCrashThrottleState>();
  /** Kinds with a summary timer in this process. */
  private readonly scheduled = new Set<string>();

  constructor(deps: HostCrashReportThrottleDeps) {
    this.deps = deps;
  }

  report(event: HostCrashEvent): void {
    const key = event.fingerprint.join("|");
    const at = this.deps.now();
    const existing = this.states.get(key);
    const state =
      existing !== undefined && !this.hasGoneQuiet(key, existing, at)
        ? existing
        : undefined;
    if (state === undefined) {
      // Throws past here when the capture fails, before anything is
      // recorded: a crash that was never sent does not spend a full report.
      this.deps.capture(event);
      this.states.set(key, {
        reported: 1,
        lastCrashAt: at,
        suppressedCount: 0,
        lastSuppressed: null,
        windowStartedAt: at,
      });
      this.persist();
      return;
    }
    state.lastCrashAt = at;
    if (state.reported < HOST_CRASH_REPORTS_BEFORE_THROTTLE) {
      this.deps.capture(event);
      state.reported += 1;
      this.persist();
      return;
    }
    state.suppressedCount += 1;
    state.lastSuppressed = event;
    if (!this.scheduled.has(key)) {
      state.windowStartedAt = at;
      this.scheduleSummary(key, HOST_CRASH_SUMMARY_WINDOW_MS);
    }
    this.persist();
  }

  /**
   * The state worth keeping, for {@link HostCrashReportThrottleDeps.persist}.
   * A kind that is quiet (nothing held back, a whole window since its last
   * crash) reads the same as an absent one, so it is left out; if more than
   * {@link MAX_PERSISTED_KINDS} kinds remain, the most recently crashed are
   * kept, so a bound on the file never costs the kind that is looping now.
   */
  snapshot(): PersistedHostCrashThrottle {
    const at = this.deps.now();
    const live: [string, HostCrashThrottleState][] = [];
    for (const [key, state] of this.states) {
      if (this.hasGoneQuiet(key, state, at)) continue;
      live.push([key, state]);
    }
    live.sort((a, b) => b[1].lastCrashAt - a[1].lastCrashAt);
    const out = new Map<string, PersistedHostCrashKind>();
    for (const [key, state] of live.slice(0, MAX_PERSISTED_KINDS)) {
      out.set(key, {
        reported: state.reported,
        lastCrashAt: state.lastCrashAt,
        suppressedCount: state.suppressedCount,
        windowStartedAt: state.windowStartedAt,
        lastSuppressed:
          state.lastSuppressed === null
            ? null
            : {
                message: state.lastSuppressed.message,
                level: state.lastSuppressed.level,
                fingerprint: state.lastSuppressed.fingerprint,
                hostId: state.lastSuppressed.hostId,
                tags: state.lastSuppressed.tags,
              },
      });
    }
    return out;
  }

  /**
   * Take in what an earlier supervisor (or a concurrent one) left on disk. A
   * kind this process has seen more recently keeps its own state. A count that
   * was left open is sent when its window ends, at once when it already has:
   * the supervisor that opened it may not have lived to send it, and a kind
   * with a count still unsent never counts as quiet.
   */
  restore(persisted: PersistedHostCrashThrottle): void {
    const now = this.deps.now();
    let clamped = false;
    for (const [key, kind] of persisted) {
      // No time in the state may lie ahead of now, so a clock that stepped
      // back holds a kind for at most one window, as any recent crash does,
      // and never for as long as the step. (Treating a future time as "long
      // quiet" instead would give every clock correction a fresh budget.)
      const lastCrashAt = Math.min(kind.lastCrashAt, now);
      const windowStartedAt = Math.min(kind.windowStartedAt, now);
      const existing = this.states.get(key);
      if (existing !== undefined && existing.lastCrashAt >= lastCrashAt) {
        continue;
      }
      if (
        lastCrashAt !== kind.lastCrashAt ||
        windowStartedAt !== kind.windowStartedAt
      ) {
        clamped = true;
      }
      this.states.set(key, {
        reported: kind.reported,
        lastCrashAt,
        suppressedCount: kind.suppressedCount,
        windowStartedAt,
        lastSuppressed:
          kind.lastSuppressed === null
            ? null
            : { ...kind.lastSuppressed, extra: {} },
      });
    }
    // The clamped times are what the scheduling below counts from, so they are
    // what the next supervisor has to start from too: otherwise a run of short
    // supervisors would each restart the full hour from the same future time.
    if (clamped) this.persist();
    for (const [key, state] of [...this.states]) {
      if (
        state.suppressedCount === 0 ||
        state.lastSuppressed === null ||
        this.scheduled.has(key)
      ) {
        continue;
      }
      const remaining =
        state.windowStartedAt + HOST_CRASH_SUMMARY_WINDOW_MS - now;
      if (remaining <= 0) {
        this.sendSummary(key);
      } else {
        this.scheduleSummary(key, remaining);
      }
    }
  }

  private scheduleSummary(key: string, delayMs: number): void {
    this.scheduled.add(key);
    this.deps.schedule(() => {
      this.sendSummary(key);
    }, delayMs);
  }

  /**
   * Quiet for a whole window with nothing left to send. A count whose summary
   * failed is kept, so the next window's summary carries it.
   */
  private hasGoneQuiet(
    key: string,
    state: HostCrashThrottleState,
    at: number,
  ): boolean {
    return (
      !this.scheduled.has(key) &&
      state.suppressedCount === 0 &&
      at - state.lastCrashAt >= HOST_CRASH_SUMMARY_WINDOW_MS
    );
  }

  private sendSummary(key: string): void {
    this.scheduled.delete(key);
    const state = this.states.get(key);
    if (
      state === undefined ||
      state.suppressedCount === 0 ||
      state.lastSuppressed === null
    ) {
      return;
    }
    try {
      this.deps.captureSummary(
        state.lastSuppressed,
        state.suppressedCount,
        state.windowStartedAt,
      );
    } catch {
      // Runs from a timer, where a throw would be an uncaught exception in
      // the supervisor. The count stays for the next window's summary.
      return;
    }
    state.suppressedCount = 0;
    state.lastSuppressed = null;
    this.persist();
  }

  private persist(): void {
    try {
      this.deps.persist(this.snapshot());
    } catch {
      // Best-effort: the in-memory state still bounds this process.
    }
  }
}

const MAX_PERSISTED_STRING = 256;
const MAX_PERSISTED_TAGS = 48;
const MAX_PERSISTED_BYTES = 256 * 1024;
const PERSISTED_THROTTLE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PERSISTED_STRING;
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parsePersistedEvent(value: unknown): PersistedHostCrashEvent | null {
  if (!isRecord(value)) return null;
  const { message, level, fingerprint, hostId, tags } = value;
  if (!isBoundedString(message)) return null;
  if (level !== "error" && level !== "warning") return null;
  if (
    !Array.isArray(fingerprint) ||
    fingerprint.length === 0 ||
    fingerprint.length > 8 ||
    !fingerprint.every(isBoundedString)
  ) {
    return null;
  }
  if (hostId !== null && !isBoundedString(hostId)) return null;
  if (!isRecord(tags)) return null;
  const tagEntries = Object.entries(tags);
  if (tagEntries.length > MAX_PERSISTED_TAGS) return null;
  const parsedTags: Record<string, string> = {};
  for (const [name, tagValue] of tagEntries) {
    if (typeof tagValue !== "string") return null;
    // A tag the host wrote can be longer than the cap (a local install's
    // version is derived from a path). Cut, never reject: rejecting would
    // drop the whole kind and hand a crash loop a fresh budget.
    parsedTags[name] = tagValue.slice(0, MAX_PERSISTED_STRING);
  }
  return {
    message,
    level,
    fingerprint: [...fingerprint],
    hostId,
    tags: parsedTags,
  };
}

/**
 * Read the throttle state file's text back. Anything that is not exactly what
 * {@link serializeHostCrashThrottle} writes is not state: a torn or foreign
 * file reads as empty (every kind then reports in full) and one bad kind is
 * dropped alone. Never throws.
 */
export function parsePersistedHostCrashThrottle(
  text: string,
): Map<string, PersistedHostCrashKind> {
  const out = new Map<string, PersistedHostCrashKind>();
  if (text.length > MAX_PERSISTED_BYTES) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isRecord(parsed) || parsed.version !== PERSISTED_THROTTLE_VERSION) {
    return out;
  }
  const kinds = parsed.kinds;
  if (!isRecord(kinds)) return out;
  for (const [key, value] of Object.entries(kinds)) {
    if (out.size >= MAX_PERSISTED_KINDS) break;
    if (!isBoundedString(key) || !isRecord(value)) continue;
    const { reported, lastCrashAt, suppressedCount, windowStartedAt } = value;
    if (
      !isCount(reported) ||
      !isTime(lastCrashAt) ||
      !isCount(suppressedCount) ||
      !isTime(windowStartedAt)
    ) {
      continue;
    }
    const lastSuppressed =
      value.lastSuppressed === null
        ? null
        : parsePersistedEvent(value.lastSuppressed);
    // A count with no event to send it as is not a count that can be sent.
    if (suppressedCount > 0 && lastSuppressed === null) continue;
    out.set(key, {
      reported,
      lastCrashAt,
      suppressedCount,
      windowStartedAt,
      lastSuppressed,
    });
  }
  return out;
}

export function serializeHostCrashThrottle(
  state: PersistedHostCrashThrottle,
): string {
  const kinds: Record<string, PersistedHostCrashKind> = {};
  for (const [key, kind] of state) {
    kinds[key] = kind;
  }
  return `${JSON.stringify({ version: PERSISTED_THROTTLE_VERSION, kinds })}\n`;
}

/**
 * The file's text, or the empty string for a file longer than
 * {@link MAX_PERSISTED_BYTES}: the size is checked on the open handle before
 * anything is allocated, and the read is capped at the cap either way (a file
 * can grow between the check and the read).
 */
async function readBounded(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_PERSISTED_BYTES) return "";
    const buffer = Buffer.alloc(size + 1);
    // A read can return fewer bytes than asked without being at the end, so
    // read until the buffer is full (the file grew) or the file ends.
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled > size ? "" : buffer.toString("utf8", 0, filled);
  } finally {
    await handle.close();
  }
}

/**
 * One environment's throttle with its state file. The file is replaced whole
 * by a rename, so a reader sees one writer's complete state or the other's,
 * never a mix; two supervisors on one machine can lose a count to each other,
 * which only ever reports a little more, never throws and never corrupts.
 */
class HostCrashThrottleEntry {
  readonly throttle: HostCrashReportThrottle;
  private readonly path: string;
  private writes: Promise<void> = Promise.resolve();
  private transport: Promise<void> = Promise.resolve();

  constructor(environment: Environment) {
    this.path = hostCrashThrottlePath(environment);
    this.throttle = new HostCrashReportThrottle({
      now: () => Date.now(),
      capture: captureHostCrashEvent,
      captureSummary: (event, suppressedCount, windowStartedAt) => {
        captureHostCrashSummary(event, suppressedCount, windowStartedAt);
        this.trackTransport(retireStalledTransportAfterBudget());
      },
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
      },
      persist: (state) => {
        const text = serializeHostCrashThrottle(state);
        this.writes = this.writes.then(() => this.write(text));
      },
    });
  }

  /** Read the file into the throttle; a missing or unreadable file is empty. */
  async load(): Promise<void> {
    let text = "";
    try {
      text = await readBounded(this.path);
    } catch {
      // No file yet, or none readable: nothing carries over.
    }
    this.throttle.restore(parsePersistedHostCrashThrottle(text));
  }

  /** Resolves once every write queued so far has settled. Never rejects. */
  writesSettled(): Promise<void> {
    return this.writes;
  }

  /**
   * Remember an envelope still on its way out. A summary clears its count on
   * disk when it is queued, so one lost with the process is not retried.
   */
  trackTransport(delivery: Promise<void>): void {
    this.transport = Promise.all([this.transport, delivery]).then(
      () => undefined,
    );
  }

  /**
   * Resolves once the state writes and the envelopes sent so far have settled
   * (the transport within its own timeout). Never rejects.
   */
  async settled(): Promise<void> {
    // A summary timer can queue more while this waits, so go round again
    // until neither tail has moved.
    for (;;) {
      const writes = this.writes;
      const transport = this.transport;
      await writes;
      await transport;
      if (writes === this.writes && transport === this.transport) return;
    }
  }

  private async write(text: string): Promise<void> {
    const temporary = join(
      dirname(this.path),
      `.host-crash-throttle.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

const hostCrashThrottles = new Map<Environment, HostCrashThrottleEntry>();

function hostCrashThrottleFor(
  environment: Environment,
): HostCrashThrottleEntry {
  const existing = hostCrashThrottles.get(environment);
  if (existing !== undefined) return existing;
  const created = new HostCrashThrottleEntry(environment);
  hostCrashThrottles.set(environment, created);
  return created;
}

/**
 * Resolves once every throttle state write queued so far, by a crash report or
 * by a summary timer, and every envelope sent with them has settled (an upload
 * within its transport timeout). Never rejects. The supervisor's exit waits for
 * it, so a summary a timer sent just before a clean stop is neither sent again
 * by the next supervisor nor lost with the process.
 */
export async function settleHostCrashThrottleWrites(): Promise<void> {
  await Promise.all(
    [...hostCrashThrottles.values()].map((entry) => entry.settled()),
  );
}

/**
 * Called when a supervisor starts: take the throttle state the previous
 * supervisor left, so a count it left open is sent when its window ends even
 * if this one never sees a crash. This resolves once what it sent has been
 * written to disk and has left the machine (or its transport timeout passed):
 * a summary clears its count on disk when it is queued, so a supervisor that
 * exits with the upload still queued (an early exit for a live incumbent)
 * would otherwise lose it. The supervisor's exit waits
 * {@link HOST_CRASH_REPORT_TIMEOUT_MS} for the whole of this.
 * Never throws.
 */
export async function resumeHostCrashReports(
  environment: Environment,
): Promise<void> {
  try {
    const entry = hostCrashThrottleFor(environment);
    await entry.load();
    await entry.settled();
  } catch {
    // Best-effort, like every step of this module.
  }
}

/**
 * The default `reportHostCrash` dependency: bounded identity read, then one
 * event, or a count toward the next summary once this kind of crash is
 * repeating (see {@link HostCrashReportThrottle}). Never throws - a telemetry
 * failure on the exit path must not cost the relaunch that follows it.
 */
export async function reportHostCrashToSentry(
  telemetry: HostCrashTelemetry,
): Promise<void> {
  let identity: HostCrashIdentity | null = null;
  try {
    identity = await Promise.race([
      readHostCrashIdentity(telemetry.environment, telemetry.childPid).catch(
        () => null,
      ),
      new Promise<null>((resolve) => {
        const timer = setTimeout(
          () => resolve(null),
          HOST_CRASH_IDENTITY_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    identity = null;
  }
  try {
    const entry = hostCrashThrottleFor(telemetry.environment);
    await entry.load();
    entry.throttle.report(buildHostCrashEvent(telemetry, identity));
    // The supervisor may exit right after its last relaunch; the state it
    // leaves for the next one has to be on disk by then.
    await entry.writesSettled();
    entry.trackTransport(retireStalledTransportAfterBudget());
  } catch {
    // Intentionally silent: see the module comment.
  }
}

/**
 * Give the transport {@link HOST_CRASH_TRANSPORT_TIMEOUT_MS} to deliver, then
 * destroy any request still open. Not awaited by the caller: the supervisor
 * has already moved on to the relaunch, and this only decides the fate of the
 * socket. `flush` resolves early when the queue drains, so a healthy upload
 * costs nothing; only a stalled one reaches the destroy.
 */
function retireStalledTransportAfterBudget(): Promise<void> {
  return Sentry.flush(HOST_CRASH_TRANSPORT_TIMEOUT_MS)
    .then((drained) => {
      if (!drained) destroySentryTransportRequests();
    })
    .catch(() => {
      destroySentryTransportRequests();
    });
}
