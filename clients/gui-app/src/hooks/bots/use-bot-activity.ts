import type {
  BotActivity,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import {
  useBotSubscriptionForHost,
  type BotSubscriptionResult,
} from "@/hooks/bots/use-bot-subscription";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

export type { BotActivity, BotSessionActivity };

/**
 * What the bot's sessions are doing - its trunk and its threads by thread
 * id - as `bot.subscribe` carries it from the Tracy surface's host, which
 * serves every bot's channel. Every read of what a bot is doing goes through
 * here: the channel's and a thread's typing lines, the closed threads'
 * lines, the Tracy entry and the line under a message the bot failed to
 * answer. It joins the bot's one subscription on that host, so a reader
 * outside the surface (the Tracy entry) sees what the surface sees; a host
 * that does not run the bot serves what the bot's host wrote to the
 * environment room (T65). `null` for no bot, while the surface is closed, before the
 * first snapshot, while that host cannot read the room, and once the stream
 * closed for good: no frame will move a closed stream's last reading (the
 * channel says the stream failed). A reconnect keeps it, as the turn may yet
 * be running. A `null` trunk is one no host has written yet: unknown, not
 * idle. A thread absent from it reads idle, as an `idle` entry does.
 */
export function useBotActivity(botId: string | null): BotActivity | null {
  const hostId = useTracySurfaceStore((state) =>
    state.open ? state.hostId : null,
  );
  const subscription = useBotSubscriptionForHost({
    botId: botId ?? "",
    hostId: hostId ?? "",
    enabled: hostId !== null && botId !== null,
  });
  if (hostId === null || botId === null) return null;
  return liveActivityOf(subscription);
}

/**
 * What can be said of a bot's activity now, with why when nothing can:
 * `live`, a reading from a stream that can still move; `pending`, none yet
 * (no surface, no first snapshot, a host that cannot read the room) and one may
 * come; `closed`, the stream closed for good or the bot is gone, and none
 * will. The same subscription `useBotActivity` reads, for a caller that
 * must not take "not yet" for "never".
 */
export type BotActivityReading =
  | { readonly kind: "live"; readonly activity: BotActivity }
  | { readonly kind: "pending" }
  | { readonly kind: "closed" };

export function useBotActivityReading(botId: string): BotActivityReading {
  const hostId = useTracySurfaceStore((state) =>
    state.open ? state.hostId : null,
  );
  const subscription = useBotSubscriptionForHost({
    botId,
    hostId: hostId ?? "",
    enabled: hostId !== null,
  });
  if (hostId === null) return { kind: "pending" };
  if (subscription.error !== null || subscription.deleted) {
    return { kind: "closed" };
  }
  const activity = liveActivityOf(subscription);
  return activity === null ? { kind: "pending" } : { kind: "live", activity };
}

/**
 * A subscription's activity while it can still move: `null` once the
 * stream closed for good or the bot is gone, since no frame will update the
 * last snapshot the cache keeps. A reconnect is not a close and keeps it.
 */
export function liveActivityOf(
  subscription: BotSubscriptionResult,
): BotActivity | null {
  if (subscription.error !== null || subscription.deleted) return null;
  return subscription.snapshot?.activity ?? null;
}

/**
 * The session the bot is answering in now, across its trunk and its
 * threads: the trunk's turn before a thread's, and of the threads the one
 * that started first. `null` while none is replying, and with no reading.
 */
export function replyingSessionOf(
  activity: BotActivity | null,
): BotSessionActivity | null {
  if (activity === null) return null;
  if (activity.trunk?.state === "replying") return activity.trunk;
  let first: BotSessionActivity | null = null;
  for (const thread of Object.values(activity.threads)) {
    if (thread.state !== "replying") continue;
    if (first === null || startedBefore(thread, first)) first = thread;
  }
  return first;
}

/**
 * Whether the bot is answering anywhere now: `true` while its trunk or a
 * thread is replying, `false` once its trunk's state is known and none is,
 * `null` while that is not known (no reading, or no host has written the
 * trunk): unknown is not idle.
 */
export function botWorkingOf(activity: BotActivity | null): boolean | null {
  if (replyingSessionOf(activity) !== null) return true;
  return activity === null || activity.trunk === null ? null : false;
}

/** A session with no start time sorts after every one that has one. */
function startedBefore(a: BotSessionActivity, b: BotSessionActivity): boolean {
  if (a.startedAt === null) return false;
  return b.startedAt === null || a.startedAt < b.startedAt;
}

/**
 * The one of the bot's sessions, its trunk or a thread's, that failed or
 * parked answering `requestId` and still holds it: what the line under the
 * message reads, and what Retry and Edit are offered on. `null` for none.
 */
export function failedOnRequest(
  activity: BotActivity | null,
  requestId: string,
): BotSessionActivity | null {
  if (activity === null) return null;
  return (
    failedOn(activity.trunk, requestId) ??
    Object.values(activity.threads).find(
      (thread) => failedOn(thread, requestId) !== null,
    ) ??
    null
  );
}

/** `session` when it failed or parked answering `requestId`, else `null`. */
export function failedOn(
  session: BotSessionActivity | null,
  requestId: string,
): BotSessionActivity | null {
  return (session?.state === "failed" || session?.state === "parked") &&
    session.requestId === requestId
    ? session
    : null;
}
