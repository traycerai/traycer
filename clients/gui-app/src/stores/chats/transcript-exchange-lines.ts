import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import { exchangePairsOf, type BotExchange } from "@/lib/bots/bot-exchanges";

const EXCHANGE_LINE_KEY_PREFIX = "bot-exchanges:";

/**
 * A bot channel's (or thread's) rows with its bot's messages to other bots
 * between them, as Slack draws members joining a channel (Tracy Bots,
 * decision 174): a run of messages with no row of the list between them is
 * ONE line, placed by time among the rows. A row closes the run, and the next
 * message opens a fresh line; while a line is the last row, each new message
 * folds into it, because nothing has closed its run.
 *
 * `exchanges` are oldest first. A row is placed by `createdAt`, and a message
 * goes before the first row that came after it. The lines own no ordinal, so
 * hydration, the minimap and find, which read ordinals and roles, see none of
 * them.
 *
 * A placeholder's time is not known, so the messages between the last row
 * drawn before it and the next row drawn after it have no place yet: they are
 * left out until the rows around them hydrate, rather than collated across
 * rows nobody can see.
 *
 * A line's key is its first message's, so it keeps its place in the list as
 * the run grows.
 */
export function withBotExchangeLines(
  rows: readonly TranscriptListRow[],
  exchanges: ReadonlyArray<BotExchange>,
): readonly TranscriptListRow[] {
  if (exchanges.length === 0) return rows;
  const merged: TranscriptListRow[] = [];
  let next = 0;
  let unplaceable = false;
  const takeRunBefore = (time: number): BotExchange[] => {
    const run: BotExchange[] = [];
    while (next < exchanges.length && exchanges[next].timestamp < time) {
      run.push(exchanges[next]);
      next += 1;
    }
    return run;
  };
  for (const row of rows) {
    if (row.kind === "placeholder") {
      unplaceable = true;
      merged.push(row);
      continue;
    }
    const run = takeRunBefore(row.model.createdAt);
    if (run.length > 0 && !unplaceable) merged.push(exchangeLineRow(run));
    unplaceable = false;
    merged.push(row);
  }
  const trailing = takeRunBefore(Number.POSITIVE_INFINITY);
  if (trailing.length > 0 && !unplaceable) {
    merged.push(exchangeLineRow(trailing));
  }
  return merged;
}

function exchangeLineRow(run: ReadonlyArray<BotExchange>): TranscriptListRow {
  const id = `${EXCHANGE_LINE_KEY_PREFIX}${run[0].key}`;
  const last = run[run.length - 1];
  const model: ChatMessageModel = {
    id,
    role: "system",
    content: "",
    segments: [
      {
        id: `${id}:line`,
        kind: "bot-exchanges",
        pairs: exchangePairsOf(run),
        lastAt: last.timestamp,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: run[0].timestamp,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    runState: null,
    agentSenderInfo: null,
    agentMessage: null,
    sessionAnchor: null,
    steerBadge: null,
  };
  return { kind: "hydrated", key: id, ordinal: null, model, part: null };
}
