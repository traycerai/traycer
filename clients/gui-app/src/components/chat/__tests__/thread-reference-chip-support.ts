import type { QueryClient } from "@tanstack/react-query";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  BOT_ID,
  postThread,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { botThreadListParams } from "@/hooks/bots/use-bot-thread-list-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * What the thread-chip suites share (Tracy Bots T160): thread ids as the host
 * derives them (UUIDs), a thread summary under such an id, and the window
 * holding a bot's thread list as `useBotThreadListQuery` caches it.
 */

export const HOST_ID = "host-test";
export { BOT_ID };
export const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

export const THREAD_ID = "3f2b7c1e-9a4d-4e6f-8b21-5c7d9e0a1b23";
/** A second thread whose id shares its first 8 characters with `THREAD_ID`. */
export const SIBLING_THREAD_ID = `${THREAD_ID.slice(0, 8)}-aaaa-4bbb-8ccc-ddddeeeeffff`;
/** A thread whose id no token in these cases begins. */
export const UNRELATED_THREAD_ID = "c0ffee00-1111-4222-8333-444455556666";
export const EXCERPT = "Why did the nightly build fail?";

/** A listed thread under `threadId`, hanging off a post that reads `excerpt`. */
export function threadSummary(
  threadId: string,
  excerpt: string | null,
): BotThreadSummary {
  const listed = postThread();
  if (listed.anchor === null) throw new Error("the fixture thread has a post");
  return { ...listed, threadId, anchor: { ...listed.anchor, excerpt } };
}

/** The window holds `threads` as `botId`'s thread list, on `hostId`. */
export function holdThreads(
  queryClient: QueryClient,
  threads: ReadonlyArray<BotThreadSummary>,
  options: { readonly botId: string; readonly hostId: string },
): void {
  const answer: BotThreadListResponse = {
    threads: [...threads],
    trunkCostUsd: null,
    threadAnchors: null,
    nextCursor: null,
    total: threads.length,
  };
  queryClient.setQueryData(
    hostQueryKeys.method(
      options.hostId,
      "bot.thread.list",
      botThreadListParams(options.botId),
    ),
    answer,
  );
}
