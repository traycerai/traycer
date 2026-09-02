import {
  arch as osArch,
  platform as osPlatform,
  release as osRelease,
} from "node:os";
import * as Sentry from "@sentry/node";
import { resolveCliVersion } from "../cli-version";
import type { Environment } from "../runner/environment";
import { destroySentryTransportRequests } from "../sentry-transport";
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
  readonly fingerprint: readonly string[];
  readonly hostId: string | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, string | number | boolean>>;
}

export const HOST_CRASH_FINGERPRINT_ROOT = "host-crash";

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
  return {
    message: `Host crashed: ${cause}`,
    fingerprint: [HOST_CRASH_FINGERPRINT_ROOT, platform, kind],
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
    scope.setLevel("error");
    scope.setFingerprint([...event.fingerprint]);
    scope.setTags(event.tags);
    scope.setExtras(event.extra);
    if (event.hostId !== null) {
      // The host id, not a person: it is what makes the issue's "users"
      // column count distinct hosts.
      scope.setUser({ id: event.hostId });
    }
    Sentry.captureMessage(event.message, "error");
  });
}

/**
 * The default `reportHostCrash` dependency: bounded identity read, then one
 * event. Never throws - a telemetry failure on the exit path must not cost
 * the relaunch that follows it.
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
    captureHostCrashEvent(buildHostCrashEvent(telemetry, identity));
  } catch {
    // Intentionally silent: see the module comment.
    return;
  }
  retireStalledTransportAfterBudget();
}

/**
 * Give the transport {@link HOST_CRASH_TRANSPORT_TIMEOUT_MS} to deliver, then
 * destroy any request still open. Not awaited by the caller: the supervisor
 * has already moved on to the relaunch, and this only decides the fate of the
 * socket. `flush` resolves early when the queue drains, so a healthy upload
 * costs nothing; only a stalled one reaches the destroy.
 */
function retireStalledTransportAfterBudget(): void {
  void Sentry.flush(HOST_CRASH_TRANSPORT_TIMEOUT_MS)
    .then((drained) => {
      if (!drained) destroySentryTransportRequests();
    })
    .catch(() => {
      destroySentryTransportRequests();
    });
}
