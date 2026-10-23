import {
  botThreadListResponseSchema,
  type BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  findBot,
  formatBotTime,
  listBots,
  refuseUnlessBoundHere,
  toBotCliError,
} from "../internal/bot-host";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  resolveEndpoint,
} from "../internal/host-rpc";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer bot threads <bot>` - the threads of a bot's channel, most recent
 * activity first (`bot.thread.list`): the post each answers, its replies,
 * its open requests and its cost. Only the host the bot runs on holds its
 * threads, so on any other host the command is refused before it asks.
 */
export function buildBotThreadsCommand(opts: {
  readonly bot: string;
}): CommandFn {
  return async () => {
    const bot = findBot(await listBots(), opts.bot);
    const endpoint = await resolveEndpoint();
    refuseUnlessBoundHere(
      bot,
      endpoint.hostId,
      "its threads are listed only there.",
    );
    const { threads } = parseCanonicalHostResponse(
      "bot.thread.list",
      botThreadListResponseSchema,
      await toBotCliError(callHostRpc("bot.thread.list", { botId: bot.botId })),
    );
    return {
      data: { botId: bot.botId, threads },
      human: renderThreads(bot.title, threads),
      exitCode: 0,
    };
  };
}

export function renderThreads(
  title: string,
  threads: readonly BotThreadSummary[],
): string {
  if (threads.length === 0) return `${title} has no threads yet.`;
  const lines = threads.map(
    (thread) =>
      `  ${thread.threadId}  ${describeAnchor(thread)}  ${describeReplies(thread)}  ${describeOpenRequests(thread.openRequestCount)}  ${describeCost(thread.costUsd)}`,
  );
  return [title, ...lines].join("\n");
}

/** The post's first line, quoted. */
function describeAnchor(thread: BotThreadSummary): string {
  if (thread.anchor === null) return "(post removed)";
  return JSON.stringify(thread.anchor.text.split("\n", 1)[0]);
}

function describeReplies(thread: BotThreadSummary): string {
  if (thread.replyCount === 0) return "no replies";
  const count =
    thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`;
  return thread.lastReplyAt === null
    ? count
    : `${count}, last ${formatBotTime(thread.lastReplyAt)}`;
}

function describeOpenRequests(count: number): string {
  return count === 1 ? "1 open request" : `${count} open requests`;
}

function describeCost(costUsd: number | null): string {
  return costUsd === null ? "cost unknown" : `$${costUsd.toFixed(2)}`;
}
