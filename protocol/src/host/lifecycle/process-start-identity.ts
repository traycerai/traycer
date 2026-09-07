/**
 * The wire format for "is the process at this pid the same OS process that wrote this record?", expressed so that no wall-clock adjustment can change the answer.
 * An identity token carries a value the **kernel recorded once, at process creation, and never recomputes**.
 */

/** Opaque, platform-tagged process creation stamp: `"<platform>:<payload>"`. */
export type ProcessStartIdentity = string;

/**
 * The result of comparing two tokens.
 * Callers must map it to whatever their fail-open answer is, because it means *no comparison happened* - a missing token, a probe that failed, a record written before this field existed.
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
 * Linux: `starttime` (field 22 of `/proc/<pid>/stat`) in clock ticks since boot, qualified by the boot id.
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
 * macOS: the process creation `timeval` the kernel stored at fork, taken as the raw text `ps -o lstart=` prints for it.
 * Callers must pin `LC_ALL=C` and `TZ=UTC` on the probe so the formatting is deterministic across reads.
 */
export function formatDarwinProcessStartIdentity(
  lstart: string,
): ProcessStartIdentity | null {
  return formatToken(DARWIN_PLATFORM_TAG, lstart);
}

/** Windows: the process `CreationTime`, as the round-trip (`"o"`) string. */
export function formatWindowsProcessStartIdentity(
  creationTime: string,
): ProcessStartIdentity | null {
  return formatToken(WIN32_PLATFORM_TAG, creationTime);
}

/** Whether `value` is shaped like a token this module produced. */
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

/** Compares a recorded token against one observed now. */
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
 * Split a token into its platform tag and its **canonical** payload, or `null` if it is not a well-formed token.
 * The tag is compared separately and never normalized into the payload: tags that disagree mean a record has travelled between machines, which is a reason to know less, not to conclude a pid was recycled.
 */
function splitToken(
  value: ProcessStartIdentity,
): { readonly tag: string; readonly payload: string } | null {
  if (!isProcessStartIdentity(value)) return null;
  const separator = value.indexOf(":");
  const payload = normalizePayload(value.slice(separator + 1));
  return payload === null ? null : { tag: value.slice(0, separator), payload };
}
