import { useCallback, useEffect, useMemo, useRef } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useBotFollowedThreads } from "@/hooks/bots/use-bot-followed-threads";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { postTextOf } from "@/lib/bots/reply-row";
import type { HostRpcRegistry } from "@/lib/host";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  composeVoiceDirectory,
  threadKey,
  type DirectorySources,
  type VoiceDirectory,
} from "@/lib/voice/directory";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { tracySurfaceHostId } from "@/stores/bots/tracy-surface-store";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

/** The router's directory, read when a route is made, and read fresh before a far navigation. */
export interface VoiceDirectoryHandle {
  /** The snapshot from what the app holds now. */
  readonly current: () => VoiceDirectory;
  /** Every bot's thread list read again, then the snapshot. */
  readonly refresh: () => Promise<VoiceDirectory>;
}

const NO_BOTS: ReadonlyArray<BotRecord> = [];
const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentDescriptorV11> = [];

/**
 * The voice router's directory (Tracy Bots voice, VT3), composed from reads
 * the app already makes, all through the app-wide host: `environment.list`
 * for labels and membership, `bot.list`, each bot's `bot.thread.list` (keyed
 * as the bot's own tab and the Threads view key it, so they share one read),
 * the person's follows (taking part follows a thread), the voice's queue and
 * focus. Anchor excerpts come only from text the app already holds: the
 * bot's channel when its chat store is loaded, and the rail's own sent post;
 * no transcript is opened for them.
 *
 * Composed on demand, never on render: the router reads it at a boundary.
 */
export function useVoiceDirectory(
  client: HostClient<HostRpcRegistry> | null,
  appHostId: string | null,
  enabled: boolean,
): VoiceDirectoryHandle {
  const botsSupported =
    useHostMethodSupport(appHostId, "bot.list") === true && enabled;
  const environmentsSupported =
    useHostMethodSupport(appHostId, "environment.list") === true && enabled;
  const threadsSupported =
    useHostMethodSupport(appHostId, "bot.thread.list") === true && enabled;
  const environments = useEnvironmentListQuery(client, environmentsSupported);
  const botList = useBotListQuery(client, botsSupported);
  // No session, no bots: the per-bot reads below (thread lists, follows) are
  // made only while a session runs.
  const bots = enabled ? (botList.data?.bots ?? NO_BOTS) : NO_BOTS;
  const lists = useHostQueries<HostRpcRegistry, "bot.thread.list">({
    client,
    requests: useMemo(
      () =>
        bots.map((bot) => ({
          method: "bot.thread.list",
          params: { botId: bot.botId },
        })),
      [bots],
    ),
    cacheKeyIdentity: undefined,
    options: { enabled: threadsSupported, refetchOnWindowFocus: false },
  });
  const followed = useBotFollowedThreads(client, appHostId ?? "", bots);
  const viewerUserId = useAuthStore((state) => state.profile?.userId ?? null);

  // The latest reads, for a composition made outside render.
  const environmentRows = environments.data?.environments ?? NO_ENVIRONMENTS;
  const latest = useRef({
    environments: environmentRows,
    bots,
    lists,
    followed,
    viewerUserId,
    appHostId,
  });
  useEffect(() => {
    latest.current = {
      environments: environmentRows,
      bots,
      lists,
      followed,
      viewerUserId,
      appHostId,
    };
  }, [appHostId, bots, environmentRows, followed, lists, viewerUserId]);

  const compose = useCallback(
    (
      threadsByBot: ReadonlyMap<string, ReadonlyArray<BotThreadSummary>>,
    ): VoiceDirectory => {
      const read = latest.current;
      const voice = useVoiceSessionStore.getState();
      const followedThreads = new Set<string>();
      if (read.followed.kind === "listed") {
        for (const entry of read.followed.threads) {
          followedThreads.add(
            threadKey(entry.bot.botId, entry.thread.threadId),
          );
        }
      }
      const surfaceHostId = tracySurfaceHostId();
      const hostOf = (): string | null => surfaceHostId ?? read.appHostId;
      const sources: DirectorySources = {
        environments: read.environments,
        bots: read.bots,
        threadsByBot,
        followedThreads,
        viewerUserId: read.viewerUserId,
        focus: voice.focus,
        queue: voice.queue,
        hostOf,
        heldPostText: (botId, messageId) =>
          heldPostText(read.bots, hostOf, botId, messageId),
      };
      return composeVoiceDirectory(sources);
    },
    [],
  );

  const current = useCallback((): VoiceDirectory => {
    const read = latest.current;
    return compose(
      threadsByBotOf(
        read.bots,
        read.lists.map((l) => l.data),
      ),
    );
  }, [compose]);

  const refresh = useCallback(async (): Promise<VoiceDirectory> => {
    const read = latest.current;
    if (!threadsSupported) return current();
    const fresh = await Promise.all(read.lists.map((list) => list.refetch()));
    return compose(
      threadsByBotOf(
        read.bots,
        fresh.map((list) => list.data),
      ),
    );
  }, [compose, current, threadsSupported]);

  return useMemo(() => ({ current, refresh }), [current, refresh]);
}

function threadsByBotOf(
  bots: ReadonlyArray<BotRecord>,
  answers: ReadonlyArray<
    { readonly threads: ReadonlyArray<BotThreadSummary> } | undefined
  >,
): ReadonlyMap<string, ReadonlyArray<BotThreadSummary>> {
  const byBot = new Map<string, ReadonlyArray<BotThreadSummary>>();
  bots.forEach((bot, index) => {
    const answer = answers[index];
    if (answer !== undefined) byBot.set(bot.botId, answer.threads);
  });
  return byBot;
}

/**
 * A channel row's text the app already holds: the rail's own sent post for
 * the thread it opened, else the row in the bot's channel store when that
 * chat is loaded in this window. Peeked, never opened.
 */
function heldPostText(
  bots: ReadonlyArray<BotRecord>,
  hostOf: (botId: string) => string | null,
  botId: string,
  messageId: string,
): string | null {
  const { byBotId } = useBotOpenThreadStore.getState();
  const rail = Object.hasOwn(byBotId, botId) ? byBotId[botId] : null;
  if (
    rail !== null &&
    rail.kind === "thread" &&
    rail.anchorMessageId === messageId &&
    rail.sent !== null
  ) {
    return rail.sent.text;
  }
  const channelChatId =
    bots.find((bot) => bot.botId === botId)?.appConversationChatId ?? null;
  const hostId = hostOf(botId);
  if (channelChatId === null || hostId === null) return null;
  const handle = getChatSessionRegistry().peek(botId, channelChatId, hostId);
  const row =
    handle?.store
      .getState()
      .messages.find((message) => message.messageId === messageId) ?? null;
  return postTextOf(row);
}
