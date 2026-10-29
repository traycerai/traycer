import { useCallback, useMemo } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  botMemorySubscribeServerFrameSchema,
  type BotMemory,
} from "@traycer/protocol/host/bot/schemas";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import {
  resetSharedStreamSubscriptions,
  useSharedStreamSubscription,
  type SharedStreamSubscription,
  type SharedStreamSubscriptionRegistry,
} from "@/hooks/pr/shared-stream-subscription";

export type { BotMemory };

/**
 * What a bot knows, as one reader sees it:
 *
 *  - `loading` until the first answer;
 *  - `ready` with the entries the bot reads before every reply, kept live;
 *  - `failed` when the host could not read them, or the live view closed,
 *    with a retry that opens it again;
 *  - `unsupported` on a host without the read, which draws no memory.
 */
export type BotMemoryReading =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly memory: BotMemory }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "unsupported" };

type MemoryEvent =
  | { readonly kind: "snapshot"; readonly memory: BotMemory | null }
  | { readonly kind: "closed" };

type StreamClient = IHostStreamClient<HostStreamRpcRegistry>;

/**
 * One session per client, host, bot and environment, however many readers
 * mount: the profile card's count and the memory pane share it.
 */
const sessions: SharedStreamSubscriptionRegistry<MemoryEvent> = new Map();

/** Test helper: tear every session down and empty the registry. */
export function __resetBotMemorySessionsForTesting(): void {
  resetSharedStreamSubscriptions(sessions);
}

/**
 * The bot's memory through `hostId`'s own stream client - the bot tab's
 * host, bound for life - from the room of the bot's environment
 * (`bot.memory.subscribe`, Tracy Bots T87). Read-only: nothing here changes
 * an entry.
 */
export function useBotMemory(args: {
  readonly hostId: string;
  readonly botId: string;
  readonly environmentId: string;
  readonly enabled: boolean;
}): BotMemoryReading {
  const { hostId, botId, environmentId, enabled } = args;
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(target, auth);
  const support = useStreamMethodSupportFor(client, "bot.memory.subscribe");
  const sessionKey =
    client === null
      ? null
      : `${client.instanceId}|${hostId}|${botId}|${environmentId}`;

  const createSession =
    useCallback((): SharedStreamSubscription<MemoryEvent> => {
      if (client === null) {
        throw new Error("A bot's memory needs a client.");
      }
      return openSession(client, botId, environmentId);
    }, [client, botId, environmentId]);

  const { lastEvent, sendRefresh } = useSharedStreamSubscription({
    registry: sessions,
    sessionKey,
    // Opened while support is unknown too: a host without the method says
    // so as it answers, and the reading turns `unsupported` then.
    enabled: enabled && support !== "unsupported",
    consumerLabel: "bot-memory-consumer",
    createSession,
    onConsumerJoined: noop,
  });

  const retry = useCallback(() => {
    // A memory the host could not read leaves the session open; it is
    // replaced, as a closed one is, so the host is asked again.
    const current = sessionKey === null ? undefined : sessions.get(sessionKey);
    if (current !== undefined && !current.isTerminal) {
      current.isTerminal = true;
      current.unsubscribeFromStream();
    }
    sendRefresh();
  }, [sessionKey, sendRefresh]);

  return useMemo((): BotMemoryReading => {
    if (support === "unsupported") return { kind: "unsupported" };
    if (lastEvent === null) return { kind: "loading" };
    if (lastEvent.kind === "closed" || lastEvent.memory === null) {
      return { kind: "failed", retry };
    }
    return { kind: "ready", memory: lastEvent.memory };
  }, [lastEvent, retry, support]);
}

function noop(): void {}

function openSession(
  client: StreamClient,
  botId: string,
  environmentId: string,
): SharedStreamSubscription<MemoryEvent> {
  const session = client.subscribe("bot.memory.subscribe", {
    botId,
    environmentId,
  });
  let closed = false;
  const shared: SharedStreamSubscription<MemoryEvent> = {
    refCount: 0,
    unsubscribeFromStream: () => {
      closed = true;
      session.close();
    },
    // No refresh frame on this stream: a retry replaces the session.
    sendRefresh: () => undefined,
    lastEvent: null,
    isTerminal: false,
    consumers: new Map(),
  };
  const publish = (event: MemoryEvent): void => {
    shared.lastEvent = event;
    for (const consumer of shared.consumers.values()) consumer();
  };
  session.onServerFrame((envelope) => {
    if (closed) return;
    const parsed = botMemorySubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.kind !== "snapshot") return;
    publish({ kind: "snapshot", memory: parsed.data.memory });
  });
  session.onStatusChange((status, reason) => {
    if (closed || status !== "closed") return;
    // A retryable close is the transport redialing this same session.
    if (reason?.kind === "fatalError" && reason.details.retryable === true) {
      return;
    }
    closed = true;
    shared.isTerminal = true;
    session.close();
    publish({ kind: "closed" });
  });
  return shared;
}
