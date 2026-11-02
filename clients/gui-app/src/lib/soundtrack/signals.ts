import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import { classifyNotificationLifecycle } from "@/lib/notifications/notification-lifecycle";
import { isTracyPath, readActiveEpicIdFromPath } from "@/lib/routes";
import type { EpicAgentActivity } from "@/lib/agent-activity";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";
import { MIX_TUNING } from "./mix-tuning";

/** The kind of view in front, which picks the track as a planet does. */
export type SoundtrackView = "home" | "task" | "bot" | "settings";

/**
 * What a director may read: a view kind and four small counts. No title, body
 * or identifier ever enters a signal.
 */
export interface MixSignals {
  readonly view: SoundtrackView;
  /** Agents with a turn in flight, up to the cap on their intensity term. */
  readonly working: number;
  /** Unread rows in the `blocking` attention tier. */
  readonly blocking: number;
  /** Unread rows in the `failure` attention tier. */
  readonly failure: number;
  /** `done` rows inside `MIX_TUNING.doneWindowMs`, read or not. */
  readonly done: number;
}

type MixFeedSignals = Pick<MixSignals, "blocking" | "failure" | "done">;

type FeedRow = Pick<
  MergedNotificationRow,
  "source" | "severity" | "readAt" | "botAnswer" | "createdAt"
>;

/**
 * Settings open as an overlay stands in front of the page beneath it, so it
 * wins over the path. A path no other kind claims, such as a draft or the task
 * list, has no task in front yet, and is home.
 */
export function soundtrackViewOfLocation(
  pathname: string,
  settingsOverlay: boolean,
): SoundtrackView {
  if (settingsOverlay || isSettingsPath(pathname)) return "settings";
  if (isTracyPath(pathname)) return "bot";
  if (readActiveEpicIdFromPath(pathname) !== null) return "task";
  return "home";
}

/**
 * Either side of now, because `createdAt` is the origin host's clock: a row a
 * little ahead of this one is fresh, and one far ahead of it would otherwise
 * lift the mix for as long as that clock stays wrong.
 */
function countsAsDone(row: FeedRow, now: number): boolean {
  return (
    row.severity === "done" &&
    Math.abs(now - row.createdAt) < MIX_TUNING.doneWindowMs
  );
}

export function feedSignalsOfRows(
  rows: readonly FeedRow[],
  now: number,
): MixFeedSignals {
  let blocking = 0;
  let failure = 0;
  let done = 0;
  for (const row of rows) {
    if (countsAsDone(row, now)) done += 1;
    const classification = classifyNotificationLifecycle(row);
    if (classification.section !== "attention") continue;
    if (classification.tier === "blocking") blocking += 1;
    if (classification.tier === "failure") failure += 1;
  }
  return { blocking, failure, done };
}

/**
 * When the next `done` row stops counting, so that its leaving is a signal
 * change like any other. Null when none is counting.
 */
export function nextDoneExpiry(
  rows: readonly FeedRow[],
  now: number,
): number | null {
  let soonest: number | null = null;
  for (const row of rows) {
    if (!countsAsDone(row, now)) continue;
    const expiresAt = row.createdAt + MIX_TUNING.doneWindowMs;
    if (soonest === null || expiresAt < soonest) soonest = expiresAt;
  }
  return soonest;
}

/** Distinct agents with a turn in flight, across every epic of every host. */
export function agentTurnsInFlight(
  byHost: ReadonlyMap<
    string,
    { readonly byEpic: ReadonlyMap<string, EpicAgentActivity> }
  >,
): number {
  const agentIds = new Set<string>();
  for (const host of byHost.values()) {
    for (const activity of host.byEpic.values()) {
      for (const agentId of activity.turn) agentIds.add(agentId);
    }
  }
  return agentIds.size;
}

/** The bot's trunk and threads with a turn running. */
export function botTurnsInFlight(activity: BotActivity | null): number {
  if (activity === null) return 0;
  const sessions = [activity.trunk, ...Object.values(activity.threads)];
  return sessions.filter((session) => session?.state === "replying").length;
}

export function sameMixSignals(left: MixSignals, right: MixSignals): boolean {
  return (
    left.view === right.view &&
    left.working === right.working &&
    left.blocking === right.blocking &&
    left.failure === right.failure &&
    left.done === right.done
  );
}
