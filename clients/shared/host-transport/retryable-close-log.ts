/**
 * The one diagnostic a swallowed retryable close leaves behind, bounded.
 *
 * A retryable `fatalError` is handled inside the transport as an ordinary
 * drop, so its `code` and `reason` reach no consumer and only this log line
 * carries them to support. Both fields are REMOTE and the wire schema bounds
 * neither their length nor their charset (`framework/ws-protocol.ts`), so
 * rendering them verbatim hands one accepted frame two ways to hurt: an
 * arbitrarily large console write per reconnect, and a CR/LF inside the reason
 * that ends this line and opens a forged one under a level it never earned.
 * That is the same reasoning the host applies to remote bodies with
 * `describeErrorBody`; this is its client-side counterpart, kept in its own
 * module so it can be tested without a socket.
 *
 * The DEDUP key is derived from the same bounded pieces, so what a session
 * retains across an indefinite reconnect loop is bounded too. It stays an
 * exact-match key by design: suppression is for the host that refuses the same
 * subscribe every time, and a genuinely different refusal is worth its own
 * line.
 */

/**
 * Longest remote reason rendered into a line. Generous enough for a real host
 * sentence ("Chat store at <path> is not usable by this build ...") and far
 * below anything that would matter in a console.
 */
const MAX_LOGGED_REASON_CHARS = 200;

/**
 * Longest remote code rendered into a line. A code is an identifier, not
 * prose - every one this repo emits is well under this - so the bound doubles
 * as a shape check: anything longer is not a code and is not worth printing.
 */
const MAX_LOGGED_CODE_CHARS = 64;

/**
 * How much of an unbounded reason is examined at all. Collapsing whitespace
 * can only shorten the text, so a prefix a few times the budget can still fill
 * it, and everything past that could not have been rendered anyway.
 */
const REASON_SCAN_CHARS = MAX_LOGGED_REASON_CHARS * 4;

export interface RetryableCloseLog {
  /** The warn line, safe to hand to `console.warn` verbatim. */
  readonly line: string;
  /** Bounded key for suppressing the identical close on the next reconnect. */
  readonly fingerprint: string;
  /**
   * The host's code, bounded to the allowlisted shape - safe to RETAIN in
   * client state, where the pre-snapshot pane and the issue report show it.
   *
   * Exposed because the log is not the only consumer any more: the session
   * carries the last retryable close to its consumer on the reconnecting
   * transition, and what it carries must be these bounded fields, never the
   * raw wire values. A placeholder (`<empty>`/`<oversized>`/`<unprintable>`)
   * never equals a real code, so anything comparing it fails closed on a code
   * this bound rejected.
   */
  readonly code: string;
  /** The reason, control-free, collapsed to one line, and length-bounded. */
  readonly reason: string;
}

export function describeRetryableClose(input: {
  /** This client's own subscribed method - local, so not sanitized. */
  readonly method: string;
  readonly code: string;
  readonly reason: string;
}): RetryableCloseLog {
  const code = describeRemoteCode(input.code);
  const reason = describeRemoteReason(input.reason);
  return {
    code,
    reason,
    line: `[stream] host closed the stream as retryable; reconnecting (method=${input.method}, code=${code}): ${reason}`,
    // The same two bounded fields, so the key a session holds for the life of
    // a reconnect loop is bounded by construction. The separator is a
    // character neither field can contain (both are control-free above), so no
    // two distinct closes collide by shifting the boundary between them.
    fingerprint: [input.method, code, reason].join(FINGERPRINT_SEPARATOR),
  };
}

const FINGERPRINT_SEPARATOR = String.fromCharCode(0);

/**
 * A remote code as a log line may carry it: an allowlisted identifier, or a
 * placeholder naming why it was withheld. Allowlisted rather than escaped
 * because a code is a closed shape, and printing one field's odd bytes is not
 * something a reader ever needs - the placeholder plus the reason below tells
 * them everything the raw value would.
 */
function describeRemoteCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) return "<empty>";
  if (trimmed.length > MAX_LOGGED_CODE_CHARS) return "<oversized>";
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) return "<unprintable>";
  return trimmed;
}

/**
 * A remote reason as a log line may carry it: control characters replaced
 * (never merely stripped - a removed newline silently glues two sentences
 * together, where a space keeps the text honest), whitespace collapsed so the
 * line stays one line, and truncated with an ellipsis so a reader can see that
 * it was.
 */
function describeRemoteReason(reason: string): string {
  // Bounded BEFORE the per-character pass: the frame is unbounded, and walking
  // a megabyte of remote text is itself a cost this function exists to refuse.
  const scanned = reason.slice(0, REASON_SCAN_CHARS);
  const normalized = Array.from(scanned, replaceControlCharacter)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return "<empty>";
  // Dropped content is what earns the ellipsis, whether it was dropped by the
  // budget below or by the scan bound above.
  const dropped =
    normalized.length > MAX_LOGGED_REASON_CHARS ||
    reason.length > scanned.length;
  if (!dropped) return normalized;
  return `${normalized.slice(0, MAX_LOGGED_REASON_CHARS - 1)}…`;
}

/**
 * One character, or a space where it was a C0 control, DEL, or a C1 control.
 * Tested by code point rather than by a character class so this module carries
 * no control characters of its own.
 */
function replaceControlCharacter(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20) return " ";
  if (code >= 0x7f && code <= 0x9f) return " ";
  return char;
}
