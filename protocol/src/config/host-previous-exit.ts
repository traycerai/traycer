import { join } from "node:path";
import {
  HOST_PREVIOUS_EXIT_KINDS,
  type HostPreviousExitKind,
} from "./host-previous-exit-kinds";

/**
 * The previous-exit record: how the host process the supervisor ran last
 * ended.
 *
 * Written by the supervisor (`traycer host start`) each time its child ends,
 * right after the terminal marker it appends to `host.log` when the exit has
 * one (a requested restart has none, and still writes a `stopped` record),
 * and replaced whole on every exit, so it always describes the host that ran
 * before the
 * current one. Read by the host at boot: a host that starts after an
 * out-of-memory abort says so, once, to the person and on `host.status`.
 *
 * The terminal marker stays the support log's line; this is the same fact in
 * a form a second process can read without re-implementing the marker
 * grammar or scanning a log it does not own. The shape lives HERE, in
 * `@traycer/protocol/config`, for the reason `./host-stop-intent` does: both
 * repos must resolve the same file and agree on the same bytes, and the host
 * cannot import the CLI package.
 *
 * ### THE HOST IS A READER, NEVER A WRITER
 *
 * The host never writes, clears or truncates this file. Which exits it has
 * already told the person about is its own record (by {@link
 * HostPreviousExit.attemptId}), kept beside its own state.
 *
 * ### What it carries
 *
 * Numbers and closed sets only: the supervisor's attempt id (an opaque token
 * it mints per spawn), when the child ended, how, its exit status or signal,
 * and the heap numbers of the diagnostic report when there is one. Never the
 * stderr tail, a path or a report's text.
 */

const HOST_PREVIOUS_EXIT_FILENAME = "previous-exit.json";

/**
 * The record's path, given the host runtime home that contains it. Taken as
 * a directory for the reason `hostStopIntentPath` (`./host-stop-intent`) is:
 * the CLI and the host resolve that directory through different machinery
 * that names the same place.
 */
export function hostPreviousExitPath(hostHomeDir: string): string {
  return join(hostHomeDir, HOST_PREVIOUS_EXIT_FILENAME);
}

export {
  HOST_PREVIOUS_EXIT_KINDS,
  type HostPreviousExitKind,
} from "./host-previous-exit-kinds";

export interface HostPreviousExit {
  readonly v: 1;
  /** The supervisor's id for the spawn that ended. */
  readonly attemptId: string;
  /** When the child ended, ISO 8601. */
  readonly endedAt: string;
  readonly kind: HostPreviousExitKind;
  /** The exit status, `null` for a signal death. */
  readonly exitCode: number | null;
  /** The signal, `null` for an exit-status death. */
  readonly signal: string | null;
  /** The diagnostic report's heap limit, `null` when none was read. */
  readonly heapLimitBytes: number | null;
  /** The diagnostic report's heap in use, `null` when none was read. */
  readonly heapUsedBytes: number | null;
}

/** The longest attempt id or signal name a record may carry. */
const MAX_TOKEN_LENGTH = 128;

const KINDS: ReadonlySet<string> = new Set<string>(HOST_PREVIOUS_EXIT_KINDS);

function isKind(value: unknown): value is HostPreviousExitKind {
  return typeof value === "string" && KINDS.has(value);
}

function isToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH
  );
}

function isByteCountOrNull(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `null` for anything that is not a well-formed record: a torn, foreign or
 * newer-version file reads as "no previous exit is known", which tells the
 * person nothing rather than something false.
 */
export function parseHostPreviousExit(value: unknown): HostPreviousExit | null {
  if (!isRecord(value)) return null;
  const { v, attemptId, endedAt, kind, exitCode, signal } = value;
  if (v !== 1) return null;
  if (!isToken(attemptId)) return null;
  if (typeof endedAt !== "string" || Number.isNaN(Date.parse(endedAt))) {
    return null;
  }
  if (!isKind(kind)) return null;
  if (
    exitCode !== null &&
    !(typeof exitCode === "number" && Number.isSafeInteger(exitCode))
  ) {
    return null;
  }
  if (signal !== null && !isToken(signal)) return null;
  const { heapLimitBytes, heapUsedBytes } = value;
  if (!isByteCountOrNull(heapLimitBytes)) return null;
  if (!isByteCountOrNull(heapUsedBytes)) return null;
  return {
    v: 1,
    attemptId,
    endedAt,
    kind,
    exitCode,
    signal,
    heapLimitBytes,
    heapUsedBytes,
  };
}
