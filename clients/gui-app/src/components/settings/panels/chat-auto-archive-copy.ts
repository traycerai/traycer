/**
 * Copy and validation for General ▸ Agents ▸ "Archive idle agents
 * automatically" (`chat-auto-archive-settings-row.tsx`), kept out of the
 * component file so it stays component-only for fast refresh.
 */
import type {
  ChatAutoArchiveBounds,
  ChatAutoArchiveGetResponse,
  ChatAutoArchiveSetRequest,
} from "@traycer/protocol/host/chat-auto-archive/contracts";

/** The threshold shown for an account that has never saved a policy. */
export const CHAT_AUTO_ARCHIVE_DEFAULT_IDLE_SECONDS = 3600;

/**
 * The never-saved threshold, clamped into the host's bounds. The switches
 * write the shown threshold, so a default outside the bounds would be a write
 * the host refuses. `null` bounds (read not landed) show the plain default;
 * every control is disabled then.
 */
export function chatAutoArchiveDefaultIdleSeconds(
  bounds: ChatAutoArchiveBounds | null,
): number {
  if (bounds === null) return CHAT_AUTO_ARCHIVE_DEFAULT_IDLE_SECONDS;
  return Math.min(
    Math.max(CHAT_AUTO_ARCHIVE_DEFAULT_IDLE_SECONDS, bounds.minSeconds),
    bounds.maxSeconds,
  );
}

export const CHAT_AUTO_ARCHIVE_READ_ERROR_STATUS =
  "Couldn't read the auto-archive setting from this host.";

/**
 * What the row shows and every write sends: the saved policy, or for a
 * never-saved account the defaults (off, agent-created only, the threshold
 * clamped into the host's bounds). `undefined` data (read not landed) yields
 * the defaults too; every control is disabled then.
 */
export function chatAutoArchiveShownPolicy(
  data: ChatAutoArchiveGetResponse | undefined,
): ChatAutoArchiveSetRequest {
  const policy = data?.policy ?? null;
  if (policy !== null) {
    return {
      enabled: policy.enabled,
      includeUserCreated: policy.includeUserCreated,
      idleSeconds: policy.idleSeconds,
    };
  }
  return {
    enabled: false,
    includeUserCreated: false,
    idleSeconds: chatAutoArchiveDefaultIdleSeconds(data?.bounds ?? null),
  };
}

/** The units the threshold field offers, smallest first. */
export type IdleUnit = "seconds" | "minutes" | "hours" | "days";

export const IDLE_UNIT_SECONDS: Readonly<Record<IdleUnit, number>> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86_400,
};

export const IDLE_UNIT_LABELS: Readonly<Record<IdleUnit, string>> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

export function isIdleUnit(value: string): value is IdleUnit {
  return Object.hasOwn(IDLE_UNIT_SECONDS, value);
}

/**
 * The largest unit that states `totalSeconds` as a whole number: 3600 reads
 * "1 hour", 5400 "90 minutes", 90 "90 seconds".
 */
export function idleUnitFor(totalSeconds: number): IdleUnit {
  if (totalSeconds % IDLE_UNIT_SECONDS.days === 0) return "days";
  if (totalSeconds % IDLE_UNIT_SECONDS.hours === 0) return "hours";
  if (totalSeconds % IDLE_UNIT_SECONDS.minutes === 0) return "minutes";
  return "seconds";
}

/**
 * The units the picker lists, from the SHOWN value's unit (the newest save's,
 * else the saved one). Seconds only when that value needs them: nobody picks a
 * threshold in seconds, but one in force must still be shown, and reachable
 * again, exactly.
 */
export function idleUnitsFor(shownUnit: IdleUnit): readonly IdleUnit[] {
  return shownUnit === "seconds"
    ? ["seconds", "minutes", "hours", "days"]
    : ["minutes", "hours", "days"];
}

/** `null` when `draft` × `unit` is a whole number of seconds inside `bounds`. */
export function idleDurationError(
  draft: string,
  unit: IdleUnit,
  bounds: ChatAutoArchiveBounds,
): string | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return "Enter a number.";
  if (!/^\d+$/.test(trimmed)) return "Enter a whole number.";
  const seconds = Number(trimmed) * IDLE_UNIT_SECONDS[unit];
  if (seconds < bounds.minSeconds || seconds > bounds.maxSeconds) {
    return `Choose between ${formatIdleSeconds(bounds.minSeconds)} and ${formatIdleSeconds(bounds.maxSeconds)}.`;
  }
  return null;
}

/**
 * The thresholds the picker offers by name. Anything else is "Custom", which
 * opens a number-and-unit field.
 */
export const IDLE_PRESET_SECONDS: readonly number[] = [
  3600, 21_600, 86_400, 259_200, 604_800, 2_592_000,
];

/** The presets inside the host's bounds, so no named choice is a refused write. */
export function idlePresetsWithin(
  bounds: ChatAutoArchiveBounds,
): readonly number[] {
  return IDLE_PRESET_SECONDS.filter(
    (seconds) => seconds >= bounds.minSeconds && seconds <= bounds.maxSeconds,
  );
}

/**
 * The line under the options while the setting is on. No wall-clock promise:
 * an epic nothing holds open is swept when a host next opens it.
 */
export const CHAT_AUTO_ARCHIVE_ON_FOOTNOTE =
  "Archived when a host next opens the task. A new message brings a chat back.";

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
