/**
 * The wire format for "is the process at this pid the same OS process that
 * wrote this record?", expressed so that no wall-clock adjustment can change
 * the answer.
 *
 * ### Why this exists
 *
 * Every start-time reader in both repos used to answer that question by
 * *deriving* an absolute timestamp from the current wall clock -
 * `Date.now() - <elapsed since process start>` - and comparing it against a
 * timestamp recorded earlier. Two derivations taken either side of a
 * `CLOCK_REALTIME` adjustment disagree by exactly the size of the adjustment,
 * because the elapsed term is measured from boot and the anchor is not. On a
 * machine whose realtime clock is corrected (WSL2 resuming a paused VM, a
 * laptop waking, NTP stepping) the comparison reports a *confident,
 * positively wrong* answer: "this pid was recycled onto an unrelated
 * process".
 *
 * That was not a theoretical risk. It is the mechanism behind
 * traycerai/traycer#740, where the same false verdict simultaneously made a
 * host answering a WebSocket handshake in 8ms report as unreachable AND
 * dropped the "never auto-restart a host whose process still exists" guard
 * that exists to stop exactly that outcome.
 *
 * ### The rule
 *
 * An identity token carries a value the **kernel recorded once, at process
 * creation, and never recomputes**. Reading it twice yields the same bytes no
 * matter what happened to the clock in between, so the comparison is exact
 * equality rather than a tolerance:
 *
 * | Platform | Source | Why it cannot move |
 * |---|---|---|
 * | Linux | `/proc/<pid>/stat` field 22, keyed by boot id | ticks since boot; never rebased on the realtime clock |
 * | macOS | `p_starttime` as printed by `ps -o lstart=` | a `timeval` stored at fork, only ever formatted |
 * | Windows | process `CreationTime` | a FILETIME stored at creation, only ever formatted |
 *
 * macOS and Windows record an absolute realtime instant, which sounds like it
 * should drift - it does not, because it is *stored*, not re-derived. A clock
 * step changes what "now" means; it does not rewrite a value already written
 * down. Linux records a boot-relative tick count, which needs the boot id to
 * stay comparable across a reboot.
 *
 * ### Why the format lives in the protocol package
 *
 * The reader cannot be shared. It needs `node:fs` / `node:child_process`, and
 * the two consumers sit on opposite sides of the OSS/internal boundary -
 * `clients/shared/host-lock` (published by the desktop and the CLI) and
 * `traycer-host` (which publishes the token into `pid.json`). So there are
 * deliberately two implementations, and the thing that keeps them honest is
 * this module: the token format is stated once, both sides build tokens
 * through these helpers, and `__tests__/process-start-identity.test.ts` pins
 * the bytes. A reader that drifts from the format stops matching and degrades
 * to `"unknown"` - which is safe - rather than silently comparing unlike
 * things.
 */

/**
 * Opaque, platform-tagged process creation stamp: `"<platform>:<payload>"`.
 *
 * Deliberately opaque. Consumers compare tokens with
 * {@link compareProcessStartIdentity} (or {@link compareObservedProcessStart})
 * and never parse the payload - its shape is a per-platform implementation
 * detail that may change, and the only question anyone is entitled to ask of
 * it is whether two tokens are the same process. The one parse, of a Windows
 * token for a denied read, lives in this module beside the format.
 */
export type ProcessStartIdentity = string;

/**
 * The result of comparing two tokens.
 *
 * `"unknown"` is not a soft `"different"`. Callers must map it to whatever
 * their fail-open answer is, because it means *no comparison happened* -
 * a missing token, a probe that failed, a record written before this field
 * existed. Treating it as evidence of a recycled pid is precisely the bug
 * this module was written to remove.
 */
export type ProcessStartIdentityMatch = "same" | "different" | "unknown";

const LINUX_PLATFORM_TAG = "linux";
const DARWIN_PLATFORM_TAG = "darwin";
const WIN32_PLATFORM_TAG = "win32";

/**
 * Collapses whitespace runs and trims, so incidental column padding from a
 * `ps` invocation can never present as a different process.
 */
function normalizePayload(payload: string): string | null {
  const normalized = payload.trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? null : normalized;
}

function formatToken(
  platformTag: string,
  payload: string,
): ProcessStartIdentity | null {
  const normalized = normalizePayload(payload);
  return normalized === null ? null : `${platformTag}:${normalized}`;
}

/**
 * Linux: `starttime` (field 22 of `/proc/<pid>/stat`) in clock ticks since
 * boot, qualified by the boot id.
 *
 * The tick count alone is only meaningful within one boot - after a restart
 * an unrelated process can legitimately hold the same pid *and* the same
 * offset from boot. `/proc/sys/kernel/random/boot_id` is regenerated every
 * boot, so pairing them makes `"same"` mean the same process instance rather
 * than the same position in two different timelines.
 */
export function formatLinuxProcessStartIdentity(
  bootId: string,
  startTicks: number,
): ProcessStartIdentity | null {
  if (!Number.isInteger(startTicks) || startTicks < 0) return null;
  const normalizedBootId = normalizePayload(bootId);
  if (normalizedBootId === null) return null;
  return formatToken(
    LINUX_PLATFORM_TAG,
    `${normalizedBootId} ${String(startTicks)}`,
  );
}

/**
 * macOS: the process creation `timeval` the kernel stored at fork, taken as
 * the raw text `ps -o lstart=` prints for it.
 *
 * The text is kept verbatim rather than parsed to epoch milliseconds on
 * purpose. Parsing would reintroduce exactly the class of bug this module
 * exists to remove - a locale, a timezone database update, or a DST boundary
 * changing the number a fixed stored value maps to. Comparing the printed
 * form compares the stored value. Callers must pin `LC_ALL=C` and `TZ=UTC`
 * on the probe so the formatting is deterministic across reads.
 */
export function formatDarwinProcessStartIdentity(
  lstart: string,
): ProcessStartIdentity | null {
  return formatToken(DARWIN_PLATFORM_TAG, lstart);
}

/**
 * Windows: the process `CreationTime`, as the round-trip (`"o"`) string.
 *
 * Stored at creation and only ever formatted, so it is stable across clock
 * steps for the same reason macOS's is.
 */
export function formatWindowsProcessStartIdentity(
  creationTime: string,
): ProcessStartIdentity | null {
  return formatToken(WIN32_PLATFORM_TAG, creationTime);
}

/**
 * Whether `value` is shaped like a token this module produced.
 *
 * Used by decoders reading `pid.json`: a field that is absent, null, or not a
 * well-formed token must decode to `null` ("not recorded"), never throw and
 * never be passed through - a malformed token reaching the comparator would
 * only ever produce `"unknown"`, but keeping the check at the decode boundary
 * means the reason is visible where the bad bytes entered.
 */
export function isProcessStartIdentity(
  value: unknown,
): value is ProcessStartIdentity {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  const platformTag = value.slice(0, separator);
  if (
    platformTag !== LINUX_PLATFORM_TAG &&
    platformTag !== DARWIN_PLATFORM_TAG &&
    platformTag !== WIN32_PLATFORM_TAG
  ) {
    return false;
  }
  return normalizePayload(value.slice(separator + 1)) !== null;
}

/**
 * Compares a recorded token against one observed now.
 *
 * Returns `"different"` - the only answer that authorises a caller to treat a
 * live pid as an impostor - solely when both sides are well-formed tokens
 * from the same platform and their bytes differ. Anything else is
 * `"unknown"`:
 *
 * - either side absent (an older host's `pid.json`, a probe that failed);
 * - either side malformed;
 * - the platform tags disagree, which means a record has travelled between
 *   machines or a reader is broken. That is a reason to know less, not a
 *   reason to positively conclude the pid was recycled.
 */
export function compareProcessStartIdentity(
  recorded: ProcessStartIdentity | null,
  observed: ProcessStartIdentity | null,
): ProcessStartIdentityMatch {
  if (recorded === null || observed === null) return "unknown";
  const left = splitToken(recorded);
  const right = splitToken(observed);
  if (left === null || right === null) return "unknown";
  if (left.tag !== right.tag) return "unknown";
  return left.payload === right.payload ? "same" : "different";
}

/**
 * Split a token into its platform tag and its **canonical** payload, or
 * `null` if it is not a well-formed token.
 *
 * Validation and comparison have to agree on what "the same token" means, and
 * they did not: {@link isProcessStartIdentity} accepts any payload that
 * *would* normalize to something non-empty, while the comparison was over raw
 * bytes. A writer that stored probe output directly instead of going through
 * `formatToken` therefore produced a token that passed validation yet
 * compared as `"different"` — and `ps -o lstart=` pads single-digit days, so
 * `darwin:Sun Jul  6 12:00:00 2026` and `darwin:Sun Jul 6 12:00:00 2026` are
 * one process differing by one space.
 *
 * `"different"` is the single answer that authorises a caller to treat a live
 * pid as an impostor, so a spurious one is the exact false verdict this
 * module was written to eliminate — reintroduced through the back door by
 * formatting rather than by the clock. Normalizing here closes it for every
 * writer, present and future, instead of relying on each one remembering to
 * call `formatToken`.
 *
 * The tag is compared separately and never normalized into the payload: tags
 * that disagree mean a record has travelled between machines, which is a
 * reason to know less, not to conclude a pid was recycled.
 */
function splitToken(
  value: ProcessStartIdentity,
): { readonly tag: string; readonly payload: string } | null {
  if (!isProcessStartIdentity(value)) return null;
  const separator = value.indexOf(":");
  const payload = normalizePayload(value.slice(separator + 1));
  return payload === null ? null : { tag: value.slice(0, separator), payload };
}

// ---- Windows: the read that was DENIED ---------------------------------------
//
// The Windows token above is `Process.StartTime`, which Windows PowerShell 5.1
// (.NET Framework) reads by opening the process for
// PROCESS_QUERY_INFORMATION. That open is DENIED for a process in another
// security context: session 0 (a service), another user, or this user at a
// higher integrity level - a process object's label is NO_READ_UP, so an
// elevated `traycer host update` or installer holding a lock, read by an
// unelevated CLI, refuses it too. A reader that stops there answers "cannot
// compare" for as long as that process lives, so a pid the OS handed from a
// dead holder to a service reads as a holder that might still be alive, and a
// lock or presence that waits for positive evidence waits forever.
//
// So a VERIFYING reader whose exact read was denied - and only denied - asks
// WMI instead: `Win32_Process.CreationDate`, which WMI serves for every
// process whatever the caller's rights. That answer has to decide BOTH ways.
// "different" is the reuse evidence the waiters need; "same" is just as
// required, because the elevated holder above is alive and ours, and a false
// "different" for it breaks a live lock. The comparison below is built so that
// precision alone can produce neither wrong answer.
//
// A RECORDING reader never takes this path. A token is always the exact
// round-trip string, so every value recorded today keeps comparing exactly as
// it does now; the WMI value exists only as an observation of the moment.

/**
 * How far apart, in microseconds, a WMI creation time may be from a recorded
 * token and still name the same process - both ways, inclusive.
 *
 * The recorded token keeps the FILETIME's 100 ns digit; it is truncated to
 * microseconds from its TEXT, so no floating-point step can move it. WMI's
 * `CreationDate` carries six fractional digits. Measured on Windows Server
 * 2022 across every process whose exact read succeeded (167 elevated, 30 at
 * Medium integrity) the two agreed to the microsecond every time, so WMI
 * truncates; the 1 µs either way absorbs a WMI that rounded its last digit
 * instead, and is the whole of what precision can contribute. It admits no
 * stranger: a process that took the pid over was created after the recorded
 * one had exited, never within a microsecond of that one's birth.
 */
export const WINDOWS_DENIED_READ_CREATION_TOLERANCE_MICROS = 1;

/**
 * The Windows PowerShell 5.1 script a verifying reader runs for `pid` after
 * its exact read produced nothing. Prints `readable` when the exact read would
 * have worked (so its failure was something else - a timeout, an exit), and
 * `denied <DMTF CreationDate>` only when the exact read is refused with
 * ERROR_ACCESS_DENIED. Anything else - no such process, any other error, a
 * missing WMI row - exits non-zero, which a reader treats as no answer.
 *
 * The getter is invoked as a METHOD (`get_StartTime()`), not read as the
 * `StartTime` property. Windows PowerShell 5.1 swallows an exception thrown
 * by a property getter: measured at Medium integrity against eight session-0
 * and protected pids, `$process.StartTime` yielded `$null` with nothing in
 * `$Error`, under `$ErrorActionPreference = 'Stop'` - indistinguishable from
 * any other failure, so the denial could not be told apart. A method call
 * throws `MethodInvocationException` wrapping the `Win32Exception`
 * (NativeErrorCode 5), which the catch unwraps.
 *
 * The literal holds only the integer pid; there is nothing to quote.
 */
export function buildWindowsDeniedReadFallbackScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("pid must be a positive integer");
  }
  const id = String(pid);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-Process -Id ${id}`,
    "try {",
    "  $null = $process.get_StartTime()",
    "  'readable'",
    "} catch {",
    "  $reason = $_.Exception",
    "  while ($null -ne $reason -and -not ($reason -is [System.ComponentModel.Win32Exception])) {",
    "    $reason = $reason.InnerException",
    "  }",
    "  if ($null -eq $reason -or $reason.NativeErrorCode -ne 5) { throw }",
    `  $row = Get-WmiObject Win32_Process -Filter 'ProcessId = ${id}'`,
    "  if ($null -eq $row) { exit 3 }",
    "  'denied ' + [string]$row.CreationDate",
    "}",
  ].join("\n");
}

/**
 * The creation time in the script's `denied <DMTF>` line, as UTC epoch
 * microseconds; `null` for `readable` or anything else.
 */
export function parseWindowsDeniedReadFallbackOutput(
  stdout: string,
): number | null {
  const line = stdout.trim();
  const prefix = "denied ";
  return line.startsWith(prefix)
    ? parseWindowsWmiCreationDate(line.slice(prefix.length))
    : null;
}

/**
 * A WMI DMTF datetime (`yyyymmddHHMMSS.ffffff±UUU`, offset in minutes) as UTC
 * epoch microseconds, converted with the text's OWN offset; `null` when it is
 * not one.
 *
 * WMI formats `CreationDate` from the stored FILETIME with one bias, the
 * current one, applied to the local fields and printed as the offset, so
 * subtracting the text's own offset recovers the exact UTC instant - across a
 * DST change too, and whichever bias WMI chose, since the fields and the
 * offset were produced together. A converted `DateTime` (what
 * `Get-CimInstance` returns, and what `ToUniversalTime()` then reads) instead
 * re-applies the DST rule in force at the fields' wall-clock time to fields
 * built with the current bias, and lands an hour off for a process created on
 * the other side of a change - a false "different" for a live holder. Hence
 * the raw text from `Get-WmiObject`, and no local-time conversion on either
 * side.
 */
export function parseWindowsWmiCreationDate(dmtf: string): number | null {
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u.exec(
      dmtf.trim(),
    );
  if (match === null) return null;
  const fieldsMs = utcMsOfFields(match.slice(1, 7));
  const micros = match[7];
  const sign = match[8];
  const offset = match[9];
  if (
    fieldsMs === null ||
    micros === undefined ||
    sign === undefined ||
    offset === undefined
  ) {
    return null;
  }
  const offsetMinutes = Number(offset) * (sign === "-" ? -1 : 1);
  const utcMicros = (fieldsMs - offsetMinutes * 60_000) * 1000 + Number(micros);
  return Number.isSafeInteger(utcMicros) ? utcMicros : null;
}

/**
 * A recorded Windows token's creation time as UTC epoch microseconds,
 * truncated from its text; `null` for any other token.
 */
export function windowsProcessStartIdentityMicros(
  identity: ProcessStartIdentity | null,
): number | null {
  if (identity === null) return null;
  const token = splitToken(identity);
  if (token === null || token.tag !== WIN32_PLATFORM_TAG) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/u.exec(
      token.payload,
    );
  if (match === null) return null;
  const fieldsMs = utcMsOfFields(match.slice(1, 7));
  const fraction = match[7];
  if (fieldsMs === null || fraction === undefined) return null;
  const micros = fieldsMs * 1000 + Number(fraction.slice(0, 6));
  return Number.isSafeInteger(micros) ? micros : null;
}

/**
 * What a VERIFYING read saw: the exact token, or - only when the exact read was
 * denied - WMI's creation time for the process.
 */
export type ObservedProcessStart =
  | { readonly kind: "identity"; readonly identity: ProcessStartIdentity }
  | { readonly kind: "windows-denied-read"; readonly creationMicros: number };

/**
 * {@link compareProcessStartIdentity} over a verifying observation. An exact
 * token compares exactly as it always has; a denied-read creation time
 * compares against the recorded token truncated to microseconds, within
 * {@link WINDOWS_DENIED_READ_CREATION_TOLERANCE_MICROS}. Anything that cannot
 * be compared - no observation, a recorded token that is not a Windows one -
 * is `"unknown"`.
 */
export function compareObservedProcessStart(
  recorded: ProcessStartIdentity | null,
  observed: ObservedProcessStart | null,
): ProcessStartIdentityMatch {
  if (observed === null) return "unknown";
  if (observed.kind === "identity") {
    return compareProcessStartIdentity(recorded, observed.identity);
  }
  const recordedMicros = windowsProcessStartIdentityMicros(recorded);
  if (recordedMicros === null) return "unknown";
  return Math.abs(recordedMicros - observed.creationMicros) <=
    WINDOWS_DENIED_READ_CREATION_TOLERANCE_MICROS
    ? "same"
    : "different";
}

/**
 * UTC epoch milliseconds of `[year, month, day, hour, minute, second]` digit
 * strings, or `null` when they do not name a real instant (`Date.UTC` rolls a
 * month 13 or a day 32 over instead of refusing it).
 */
function utcMsOfFields(fields: readonly string[]): number | null {
  if (fields.length !== 6) return null;
  const [year, month, day, hour, minute, second] = fields.map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  return Number.isFinite(ms) &&
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second
    ? ms
    : null;
}
