/**
 * Copy and validation for General ▸ Agents ▸ "Archive idle agents
 * automatically" (`chat-auto-archive-settings-row.tsx`), kept out of the
 * component file so it stays component-only for fast refresh.
 */
import type {
  ChatAutoArchiveBounds,
  ChatAutoArchiveSetRequest,
} from "@traycer/protocol/host/chat-auto-archive/contracts";

/** The threshold shown for an account that has never saved a policy. */
export const CHAT_AUTO_ARCHIVE_DEFAULT_IDLE_SECONDS = 3600;

export const CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS =
  "Couldn't read the auto-archive setting from this host.";

/** `null` when `draft` is a whole number of seconds inside `bounds`. */
export function idleSecondsError(
  draft: string,
  bounds: ChatAutoArchiveBounds,
): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return "Enter a number of seconds.";
  if (!/^\d+$/.test(trimmed)) return "Enter a whole number of seconds.";
  const seconds = Number(trimmed);
  if (seconds < bounds.minSeconds || seconds > bounds.maxSeconds) {
    return `Choose between ${String(bounds.minSeconds)} and ${String(bounds.maxSeconds)} seconds.`;
  }
  return null;
}

/**
 * The status sentence. No wall-clock promise: an epic nothing holds open is
 * swept when a host next opens it, which is what the second sentence says.
 */
export function chatAutoArchiveStatusLine(
  policy: ChatAutoArchiveSetRequest,
): string {
  if (!policy.enabled) return "Off on all your hosts.";
  return `After ${formatIdleSeconds(policy.idleSeconds)} of inactivity, on all your hosts. Applied when a host next looks at the chat's task.`;
}

const DURATION_UNITS: ReadonlyArray<{
  readonly seconds: number;
  readonly singular: string;
  readonly plural: string;
}> = [
  { seconds: 86_400, singular: "day", plural: "days" },
  { seconds: 3600, singular: "hour", plural: "hours" },
  { seconds: 60, singular: "minute", plural: "minutes" },
  { seconds: 1, singular: "second", plural: "seconds" },
];

/**
 * "90 seconds", "1 hour", "2 hours 30 minutes", "1 day 1 second". Below two
 * minutes the count stays in seconds, which reads better than
 * "1 minute 30 seconds" for a value the user typed in seconds.
 */
export function formatIdleSeconds(totalSeconds: number): string {
  if (totalSeconds < 120) {
    return `${String(totalSeconds)} ${totalSeconds === 1 ? "second" : "seconds"}`;
  }
  const parts: string[] = [];
  let remaining = totalSeconds;
  for (const unit of DURATION_UNITS) {
    const count = Math.floor(remaining / unit.seconds);
    if (count === 0) continue;
    remaining -= count * unit.seconds;
    parts.push(`${String(count)} ${count === 1 ? unit.singular : unit.plural}`);
  }
  return parts.join(" ");
}
