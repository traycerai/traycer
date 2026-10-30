import { useCallback, useMemo } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  botMemorySubscribeServerFrameSchema,
  type BotMemory,
} from "@traycer/protocol/host/bot/schemas";
import { botQueryKeys } from "@/lib/query-keys/bot-query-keys";
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
 *  - `ready` with the entries the bot reads before every reply, kept live
 *    (the last ones read, until a reopened view hears from the host);
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

interface MemorySlot {
  readonly hostId: string;
  readonly botId: string;
  readonly environmentId: string;
}

/**
 * One session per client, host, bot and environment, however many readers
 * mount: the profile card's count and the memory pane share it. Each memory
 * it reads lands in the host's query cache, which keeps the last one after
 * the session closes, so a reader opened again shows it while a new session
 * asks the host.
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
  const queryClient = useQueryClient();
  const slot: MemorySlot = useMemo(
    () => ({ hostId, botId, environmentId }),
    [hostId, botId, environmentId],
  );
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
      return openSession(client, queryClient, slot);
    }, [client, queryClient, slot]);

  const onConsumerJoined = useCallback(
    (shared: SharedStreamSubscription<MemoryEvent>): void => {
      const last = shared.lastEvent;
      if (last?.kind !== "snapshot" || last.memory === null) return;
      const key = botQueryKeys.memory(slot);
      if (queryClient.getQueryData(key) !== undefined) return;
      queryClient.setQueryData(key, last.memory);
    },
    [queryClient, slot],
  );

  const { lastEvent, sendRefresh } = useSharedStreamSubscription({
    registry: sessions,
    sessionKey,
    // Opened while support is unknown too: a host without the method says
    // so as it answers, and the reading turns `unsupported` then.
    enabled: enabled && support !== "unsupported",
    consumerLabel: "bot-memory-consumer",
    createSession,
    onConsumerJoined,
  });

  const { data: cached } = useQuery({
    ...queryOptions({
      queryKey: botQueryKeys.memory(slot),
      queryFn: (): Promise<BotMemory | null> => Promise.resolve(null),
      staleTime: Infinity,
    }),
    enabled: false,
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
    if (
      lastEvent !== null &&
      (lastEvent.kind === "closed" || lastEvent.memory === null)
    ) {
      return { kind: "failed", retry };
    }
    const memory = cached ?? null;
    if (memory === null) return { kind: "loading" };
    return { kind: "ready", memory };
  }, [cached, lastEvent, retry, support]);
}

function openSession(
  client: StreamClient,
  queryClient: QueryClient,
  slot: MemorySlot,
): SharedStreamSubscription<MemoryEvent> {
  const session = client.subscribe("bot.memory.subscribe", {
    botId: slot.botId,
    environmentId: slot.environmentId,
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
    const { memory } = parsed.data;
    if (memory !== null) {
      queryClient.setQueryData(botQueryKeys.memory(slot), memory);
    }
    publish({ kind: "snapshot", memory });
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
