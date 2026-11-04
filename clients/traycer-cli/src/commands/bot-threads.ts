import {
  botThreadListResponseSchema,
  type BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  findBot,
  formatBotTime,
  listBots,
  refuseUnlessSomeHostRuns,
  toBotCliError,
} from "../internal/bot-host";
import { HostMethodVersionUnsatisfiedError } from "../../../shared/host-transport/host-messenger";
import {
  callHostRpc,
  callHostRpcWithDispatch,
  parseCanonicalHostResponse,
  PLAIN_DISPATCH,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * A paged listing rides `bot.thread.list@1.2`. Below it `limit` and `cursor`
 * are stripped and the host answers every thread on one page, so a page that
 * names either requires 1.2, and an older host refuses it before anything is
 * sent.
 */
const PAGED_THREAD_LIST_DISPATCH: HostRpcDispatch = {
  ...PLAIN_DISPATCH,
  requiredHostMethodVersion: {
    method: "bot.thread.list",
    version: { major: 1, minor: 2 },
  },
};

/** The thread list as asked: unpaged on any host, paged only where the host pages. */
async function listThreads(params: {
  readonly botId: string;
  readonly limit: number | null;
  readonly cursor: string | null;
}): Promise<unknown> {
  if (params.limit === null && params.cursor === null) {
    return await toBotCliError(callHostRpc("bot.thread.list", params));
  }
  // Refused before the version is mapped: the general mapping reads it as a
  // host the CLI cannot talk to, where this one only cannot page.
  return await toBotCliError(
    callHostRpcWithDispatch(
      "bot.thread.list",
      params,
      PAGED_THREAD_LIST_DISPATCH,
    ).catch((error: unknown) => {
      if (error instanceof HostMethodVersionUnsatisfiedError) {
        throw cliError({
          code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
          message:
            "traycer: this host lists a bot's threads only all at once - run `traycer host update` to page them, or leave out --limit and --cursor.",
          details: { hostShouldUpgrade: true },
          exitCode: 1,
        });
      }
      throw error;
    }),
  );
}

/**
 * `traycer bot threads <bot>` - the threads of a bot's channel, most recent
 * activity first (`bot.thread.list`): when the post each answers was sent,
 * its replies, its open requests and its cost. Any host lists a running
 * bot's threads: another host than the bot's own lists what that host wrote
 * to the bot's environment room. `limit` pages the list (`null`: every
 * thread), and `cursor` continues after the page a listing ended.
 */
export function buildBotThreadsCommand(opts: {
  readonly bot: string;
  readonly limit: number | null;
  readonly cursor: string | null;
}): CommandFn {
  return async () => {
    const bot = findBot(await listBots(), opts.bot);
    refuseUnlessSomeHostRuns(bot);
    const { threads, nextCursor, total } = parseCanonicalHostResponse(
      "bot.thread.list",
      botThreadListResponseSchema,
      await listThreads({
        botId: bot.botId,
        limit: opts.limit,
        cursor: opts.cursor,
      }),
    );
    return {
      data: { botId: bot.botId, threads, nextCursor, total },
      human: renderThreads(bot.title, threads, nextCursor, total),
      exitCode: 0,
    };
  };
}

function renderThreads(
  title: string,
  threads: readonly BotThreadSummary[],
  nextCursor: string | null,
  total: number,
): string {
  if (total === 0) return `${title} has no threads yet.`;
  const lines = threads.map(
    (thread) =>
      `  ${thread.threadId}  ${describeAnchor(thread)}  ${describeReplies(thread)}  ${describeOpenRequests(thread.openRequestCount)}  ${describeCost(thread.costUsd)}`,
  );
  return [
    threads.length === total
      ? title
      : `${title} (${threads.length} of ${total})`,
    ...lines,
    ...(nextCursor === null ? [] : [`More: --cursor ${nextCursor}`]),
  ].join("\n");
}

/** When the post was sent; a summary names the post, not its text. */
function describeAnchor(thread: BotThreadSummary): string {
  if (thread.anchor === null) return "(post removed)";
  return `post ${formatBotTime(thread.anchor.sentAt)}`;
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
