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
 * {@link compareProcessStartIdentity} and never parse the payload - its shape
 * is a per-platform implementation detail that may change, and the only
 * question anyone is entitled to ask of it is whether two tokens are the same
 * process.
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
  return payload === null
    ? null
    : { tag: value.slice(0, separator), payload };
}
