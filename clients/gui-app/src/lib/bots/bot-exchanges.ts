import { botIdSchema } from "@traycer/protocol/host/bot/schemas";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";

/**
 * One message between a bot and another bot of its environment, as the bot's
 * Communication Graph feed holds it (Tracy Bots, decision 174). Bots talk
 * over A2A with the other bot's id as the task, so each message crosses
 * tasks and the bot's own feed names the other bot in `peerEpicId`.
 */
export interface BotExchange {
  /** The feed row's identity: its cloud id, or its host and row id. */
  readonly key: string;
  readonly timestamp: number;
  /** The other bot. */
  readonly peerBotId: string;
  /** `sent`: this bot's session wrote it; `received`: the other bot's did. */
  readonly direction: "sent" | "received";
  /** This bot's session at its end of the message. */
  readonly ownAgentId: string | null;
  readonly senderAgentId: string | null;
  readonly text: string;
  /** The broker thread the message rides. */
  readonly responseId: string | null;
  /** The `responseId` it answers; `null` for a new request. */
  readonly inReplyTo: string | null;
}

function isBotId(epicId: string): boolean {
  return botIdSchema.safeParse(epicId).success;
}

function eventKey(event: CommGraphEvent): string {
  return event.eventId ?? `${event.hostId}:${event.id}`;
}

/**
 * The bot's messages with other bots, oldest first: each message row of its
 * feed whose far end is another bot. A bot's id has its own shape, so a bot
 * the environment no longer lists is still one; a task's agent, a notice and
 * a row inside the bot's own task are not. A row this bot's session
 * (`ownAgentIds`: its trunk and its threads' sessions) sent is `sent`; any
 * other row is the other bot's, received.
 */
export function botExchangesOf(
  events: ReadonlyArray<CommGraphEvent>,
  botId: string,
  ownAgentIds: ReadonlySet<string>,
): ReadonlyArray<BotExchange> {
  const exchanges: BotExchange[] = [];
  for (const event of events) {
    if (event.kind !== "a2a_message") continue;
    const peer = event.peerEpicId;
    if (peer === null || peer === botId || !isBotId(peer)) continue;
    const sent =
      event.senderAgentId !== null && ownAgentIds.has(event.senderAgentId);
    exchanges.push({
      key: eventKey(event),
      timestamp: event.timestamp,
      peerBotId: peer,
      direction: sent ? "sent" : "received",
      ownAgentId: sent ? event.senderAgentId : event.receiverAgentId,
      senderAgentId: event.senderAgentId,
      text: event.messageText ?? "",
      responseId: event.responseId,
      inReplyTo: event.inReplyTo,
    });
  }
  return exchanges;
}

/** One other bot of a run, and how many of the run's messages were with it. */
export interface BotExchangePair {
  readonly peerBotId: string;
  readonly count: number;
}

/** A run's pairs, in the order the run first reached each other bot. */
export function exchangePairsOf(
  run: ReadonlyArray<BotExchange>,
): ReadonlyArray<BotExchangePair> {
  const counts = new Map<string, number>();
  for (const exchange of run) {
    counts.set(exchange.peerBotId, (counts.get(exchange.peerBotId) ?? 0) + 1);
  }
  return Array.from(counts, ([peerBotId, count]) => ({ peerBotId, count }));
}

/** A message of a pair's log, and the earlier one it answers. */
export interface BotExchangeLogEntry {
  readonly exchange: BotExchange;
  /** The earlier message of the log this one replies to; `null` for none. */
  readonly replyTo: BotExchange | null;
}

/**
 * Every message between the bot and `peerBotId` in the bot's feed, oldest
 * first. A reply names the request it answers by that request's
 * `responseId`: the latest earlier message on that thread from the other
 * side.
 */
export function exchangeLogOf(
  exchanges: ReadonlyArray<BotExchange>,
  peerBotId: string,
): ReadonlyArray<BotExchangeLogEntry> {
  const pair = exchanges.filter((exchange) => exchange.peerBotId === peerBotId);
  return pair.map((exchange, index) => ({
    exchange,
    replyTo: replyTargetOf(pair, index),
  }));
}

function replyTargetOf(
  pair: ReadonlyArray<BotExchange>,
  index: number,
): BotExchange | null {
  const { inReplyTo, direction } = pair[index];
  if (inReplyTo === null) return null;
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const candidate = pair[earlier];
    if (
      candidate.responseId === inReplyTo &&
      candidate.direction !== direction
    ) {
      return candidate;
    }
  }
  return null;
}
