import { HOST_RESTARTING_FATAL_CODE } from "@traycer/protocol/framework/ws-protocol";
import {
  SESSION_CLOSED_FATAL_CODE,
  SESSION_NOT_READY_FATAL_CODE,
} from "@traycer/protocol/framework/stream-ws-protocol";

/**
 * `NOT_FOUND` is the protocol-level absence signal. Reason text is operator
 * diagnostics and changes independently, so it must never decide whether the
 * UI closes an unavailable Epic.
 */
export function isUnavailableEpicCode(code: string): boolean {
  return code === "NOT_FOUND";
}

/**
 * Terminal epic-stream codes that describe a failed attempt to open, not a
 * verdict on the epic or the caller, so a session that never loaded may be
 * rebuilt for them.
 *
 * Positive on purpose: an unknown code is not retryable. The host's own
 * verdicts (`NOT_FOUND`, `FORBIDDEN`, `UNAUTHORIZED`, `ROOM_UNINITIALIZED`,
 * `LOCAL_STORE_UNAVAILABLE`), client verdicts (`INCOMPATIBLE`,
 * `HOST_OLDER_THAN_DATA`, `REMOTE_ACCESS_OFF`, `TEAM_MEMBER_REMOVED`, a stream
 * method the worker proxy does not carry) and the migration modal's close all
 * answer the same way on the next attempt.
 *
 *  - `EPIC_INIT_FAILED`: hosts before the retryable flag closed every
 *    unclassified open failure with it, bare.
 *  - `HOST_RESTARTING`: the restart tombstone, terminal when it arrives
 *    without the retryable flag.
 *  - `SESSION_NOT_READY` / `SESSION_CLOSED`: the host's session lifecycle
 *    answering "ask again".
 *  - `CLIENT_CLOSED`: the stream client was closed before it opened; a
 *    rebuilt session opens a new one.
 */
const BOOTSTRAP_RETRYABLE_EPIC_CODES: ReadonlySet<string> = new Set([
  "EPIC_INIT_FAILED",
  HOST_RESTARTING_FATAL_CODE,
  SESSION_NOT_READY_FATAL_CODE,
  SESSION_CLOSED_FATAL_CODE,
  "CLIENT_CLOSED",
]);

export function isBootstrapRetryableEpicCode(code: string): boolean {
  return BOOTSTRAP_RETRYABLE_EPIC_CODES.has(code);
}
