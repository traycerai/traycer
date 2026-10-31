import { useCallback, useMemo } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  botSubscribeServerFrameSchema,
  type BotActivity,
  type BotNotificationSubscription,
  type BotStoppedNotificationWatch,
  type BotRecord,
  type BotSubscribeServerFrame,
  type BotSurfaceActionState,
  type BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { botQueryKeys } from "@/lib/query-keys/bot-query-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { isReadCursorReadOf } from "@/hooks/bots/use-bot-read-cursor";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import {
  resetSharedStreamSubscriptions,
  useSharedStreamSubscription,
  type SharedStreamSubscription,
  type SharedStreamSubscriptionRegistry,
} from "@/hooks/pr/shared-stream-subscription";

/**
 * The `bot.subscribe` snapshot as this client caches it: the bot row, its task
 * list, the open-request HINT and the bound host.
 *
 * `openRequestCount` is rendered as it arrives and read as a hint, as the
 * contract says: the conversation's user rows (`conversationRequest`) are
 * authoritative for what is open. A surface that needs the real number
 * reads the conversation.
 */
export interface BotSubscriptionSnapshot {
  readonly bot: BotRecord;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /**
   * `null` when the serving host does not know the count: the bot's host has
   * not read its conversations yet, or another host cannot read the room.
   */
  readonly openRequestCount: number | null;
  /**
   * Moves when a row is written to the bot's channel or a thread on its
   * bound host; the bot's thread listing is read again when it does. `null`
   * while the serving host cannot read the environment room the bot's host
   * writes it to.
   */
  readonly conversationsRevision: number | null;
  readonly boundHost: {
    /** `null` when no host runs the bot. */
    readonly hostId: string | null;
    readonly epoch: number;
    readonly isThisHost: boolean;
  };
  /**
   * What the bot's running chats are doing, kept live from the stream's
   * `activity` frames, from any host (T65). `null` while the serving host
   * cannot read the environment room the bot's host writes it to.
   */
  readonly activity: BotActivity | null;
  /**
   * The bot's chats watching the person's notifications (T84). `null` when
   * the serving host does not run the bot, or predates them.
   */
  readonly notificationSubscriptions: ReadonlyArray<BotNotificationSubscription> | null;
  /**
   * The viewer's own answers and decisions from a bot's surface cards still
   * on their way to a task on another machine, or refused there (T89).
   * `null` from a host that predates them.
   */
  readonly surfaceActions: ReadonlyArray<BotSurfaceActionState> | null;
  /**
   * The watches members stopped from the Activity page (T92), with who and
   * when. `null` like `notificationSubscriptions`.
   */
  readonly stoppedNotificationWatches: ReadonlyArray<BotStoppedNotificationWatch> | null;
}

/**
 * The stream as one consumer reads it. `deleted` is terminal: the bot was
 * archived, or the caller lost it. `error` is the wording of an unexpected
 * close; the transport's own retryable reconnects never surface here.
 */
export interface BotSubscriptionResult {
  readonly snapshot: BotSubscriptionSnapshot | null;
  readonly deleted: boolean;
  readonly error: string | null;
  readonly isPending: boolean;
  /**
   * Closes this key's session and opens a fresh one. The host re-sends the
   * snapshot only for changes IT made; a bot rebound or edited from another
   * host reaches this client on the next subscribe, so a surface that comes
   * back into view asks again.
   */
  readonly resubscribe: () => void;
}

/**
 * The per-key event: the last data-bearing frame, or a synthesized terminal
 * close with its wording. `pong` frames are not events - they answer a ping
 * and change nothing a consumer reads.
 */
type BotStreamEvent =
  | Extract<BotSubscribeServerFrame, { kind: "snapshot" | "deleted" }>
  | { readonly kind: "closed"; readonly message: string };

type SharedSubscription = SharedStreamSubscription<BotStreamEvent>;

interface ActiveSubscriptionArgs {
  readonly hostId: string;
  readonly botId: string;
}

/**
 * Module-level ref-counted sessions, keyed by the owning client instance +
 * host + bot: Home's row and an open bot tab on the same host share one
 * session, while the same bot subscribed through two hosts (a tab moved to
 * its bound host, Home on the app-wide one) keeps two.
 */
const subscriptions: SharedStreamSubscriptionRegistry<BotStreamEvent> =
  new Map();

function subscriptionKeyFor(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.botId}`;
}

/** Test helper: tear every session down and empty the registry. */
export function __resetBotSubscriptionsForTesting(): void {
  resetSharedStreamSubscriptions(subscriptions);
}

/**
 * Subscribes on the APP-WIDE stream client - the Home section's reading,
 * where the hosts of many bots are a detail and the serving host's
 * `boundHost.isThisHost` says which ones are bound here.
 */
export function useBotSubscription(args: {
  readonly hostId: string | null;
  readonly botId: string;
  readonly enabled: boolean;
}): BotSubscriptionResult {
  const client = useWsStreamClient();
  return useBotSubscriptionForClient({ ...args, client });
}

/**
 * Subscribes through an explicit host's own stream client - the bot tab's
 * reading, bound to its host for life. The client is dialed for `hostId` the
 * way every per-tab stream is (`useHostStreamClientFor` with auth
 * revalidation), never read off the app-wide context.
 */
export function useBotSubscriptionForHost(args: {
  readonly hostId: string;
  readonly botId: string;
  readonly enabled: boolean;
}): BotSubscriptionResult {
  const target = useHostDirectoryEntry(args.hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(target, auth);
  return useBotSubscriptionForClient({ ...args, client });
}

export function useBotSubscriptionForClient(args: {
  readonly hostId: string | null;
  readonly botId: string;
  readonly enabled: boolean;
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
}): BotSubscriptionResult {
  const queryClient = useQueryClient();
  const { hostId, botId, enabled, client } = args;

  const activeArgs: ActiveSubscriptionArgs | null = useMemo(
    () => (hostId === null ? null : { hostId, botId }),
    [hostId, botId],
  );
  const sessionKey =
    client === null || activeArgs === null
      ? null
      : subscriptionKeyFor(client, activeArgs);

  const createSession = useCallback((): SharedSubscription => {
    if (client === null || activeArgs === null) {
      throw new Error("A bot subscription needs a client and a host.");
    }
    return createSharedSubscription(client, queryClient, activeArgs);
  }, [client, queryClient, activeArgs]);

  const onConsumerJoined = useCallback(
    (shared: SharedSubscription): void => {
      if (activeArgs === null) return;
      if (shared.lastEvent?.kind !== "snapshot") return;
      replayLastEventIntoCache(queryClient, activeArgs, shared.lastEvent);
    },
    [queryClient, activeArgs],
  );

  const { lastEvent, sendRefresh } = useSharedStreamSubscription({
    registry: subscriptions,
    sessionKey,
    enabled,
    consumerLabel: "bot-subscription-consumer",
    createSession,
    onConsumerJoined,
  });

  const { data: queryData } = useQuery({
    ...queryOptions({
      queryKey: botQueryKeys.subscription({
        hostId: hostId ?? "",
        botId,
      }),
      queryFn: (): Promise<BotSubscriptionSnapshot | null> =>
        Promise.resolve(null),
      staleTime: Infinity,
    }),
    enabled: false,
  });

  const resubscribe = useCallback(() => {
    // Marks the live session terminal first, so the shared machinery's retry
    // path REPLACES it with a fresh one (and migrates every other consumer
    // onto it) instead of treating the refresh as a frame to send - this
    // stream has no refresh frame.
    const current =
      sessionKey === null ? undefined : subscriptions.get(sessionKey);
    if (current !== undefined && !current.isTerminal) {
      current.isTerminal = true;
      current.unsubscribeFromStream();
    }
    sendRefresh();
  }, [sessionKey, sendRefresh]);

  const snapshot = queryData ?? null;
  const deleted = lastEvent?.kind === "deleted";
  const error = lastEvent?.kind === "closed" ? lastEvent.message : null;
  return {
    snapshot,
    deleted,
    error,
    isPending: snapshot === null && !deleted && error === null,
    resubscribe,
  };
}

function toSnapshot(
  frame: Extract<BotSubscribeServerFrame, { kind: "snapshot" }>,
): BotSubscriptionSnapshot {
  return {
    bot: frame.bot,
    tasks: frame.tasks,
    openRequestCount: frame.openRequestCount,
    conversationsRevision: frame.conversationsRevision,
    boundHost: frame.boundHost,
    activity: frame.activity,
    notificationSubscriptions: frame.notificationSubscriptions,
    surfaceActions: frame.surfaceActions,
    stoppedNotificationWatches: frame.stoppedNotificationWatches,
  };
}

function createSharedSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): SharedSubscription {
  const session = wsStreamClient.subscribe("bot.subscribe", {
    botId: args.botId,
  });

  let sessionClosed = false;
  const shared: SharedSubscription = {
    refCount: 0,
    unsubscribeFromStream: () => {
      sessionClosed = true;
      session.close();
    },
    // No refresh frame on this stream; `resubscribe` above replaces the
    // session instead. Kept a no-op rather than a ping so a caller that
    // reaches it never mistakes a pong for fresh data.
    sendRefresh: () => undefined,
    lastEvent: null,
    isTerminal: false,
    consumers: new Map(),
  };

  const notifyConsumers = (): void => {
    for (const consumer of shared.consumers.values()) consumer();
  };

  const markTerminal = (event: BotStreamEvent): void => {
    sessionClosed = true;
    shared.isTerminal = true;
    session.close();
    shared.lastEvent = event;
    notifyConsumers();
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed) return;
    const parsed = botSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "pong") return;
    if (frame.kind === "deleted") {
      markTerminal(frame);
      return;
    }
    if (frame.kind === "activity") {
      // One entry moved; the snapshot it patches came first on this session.
      const last = shared.lastEvent;
      if (last?.kind !== "snapshot" || last.activity === null) return;
      const activity = withActivityEntry(last.activity, frame);
      shared.lastEvent = { ...last, activity };
      notifyConsumers();
      const key = botQueryKeys.subscription(args);
      const cached =
        queryClient.getQueryData<BotSubscriptionSnapshot | null>(key) ?? null;
      if (cached !== null)
        queryClient.setQueryData(key, { ...cached, activity });
      return;
    }
    shared.lastEvent = frame;
    notifyConsumers();
    const key = botQueryKeys.subscription(args);
    const previous =
      queryClient.getQueryData<BotSubscriptionSnapshot | null>(key) ?? null;
    queryClient.setQueryData(key, toSnapshot(frame));
    // A reply, a post or a verdict on the bound host: the threads' reply
    // counts and costs moved, so their listing is read again. So is a move
    // of the bot to another binding, whose host says its own thread anchors.
    // A read already in flight may predate the move, and an invalidation
    // joins a running first read (nothing cached yet) rather than replacing
    // it, so that read is cancelled first and the listing read afresh.
    if (previous !== null && listingMoved(previous, frame)) {
      const queryKey = hostQueryKeys.method<HostRpcRegistry, "bot.thread.list">(
        args.hostId,
        "bot.thread.list",
        { botId: args.botId },
      );
      void queryClient
        .cancelQueries({ queryKey })
        .then(() => queryClient.invalidateQueries({ queryKey }));
      // The conversations' newest rows moved with it (decision 139).
      void queryClient.invalidateQueries({
        predicate: (query) => isReadCursorReadOf(query.queryKey, args.botId),
      });
    }
  });

  session.onStatusChange((status, reason) => {
    if (sessionClosed) return;
    if (status !== "closed") return;
    const message = describeStreamClose(reason);
    // A retryable close is the transport reconnecting; the next snapshot
    // repopulates the slot and nothing here should say otherwise.
    if (message === null) return;
    markTerminal({ kind: "closed", message });
  });

  return shared;
}

/** Whether `frame` moved the conversations revision or the bot's binding. */
function listingMoved(
  previous: BotSubscriptionSnapshot,
  frame: Extract<BotSubscribeServerFrame, { kind: "snapshot" }>,
): boolean {
  if (
    frame.conversationsRevision !== null &&
    frame.conversationsRevision !== previous.conversationsRevision
  ) {
    return true;
  }
  return (
    frame.boundHost.hostId !== previous.boundHost.hostId ||
    frame.boundHost.epoch !== previous.boundHost.epoch
  );
}

/** `activity` with the one entry an `activity` frame names replaced or removed. */
function withActivityEntry(
  activity: BotActivity,
  frame: Extract<BotSubscribeServerFrame, { kind: "activity" }>,
): BotActivity {
  if (frame.target.kind === "trunk") return { ...activity, trunk: frame.entry };
  const { threadId } = frame.target;
  const threads = Object.fromEntries(
    Object.entries(activity.threads).filter(([id]) => id !== threadId),
  );
  if (frame.entry !== null) threads[threadId] = frame.entry;
  return { ...activity, threads };
}

function describeStreamClose(reason: StreamCloseReason | null): string | null {
  if (
    reason !== null &&
    reason.kind === "fatalError" &&
    reason.details.retryable === true
  ) {
    return null;
  }
  if (reason === null || reason.kind === "caller") {
    return "The bot's live view closed unexpectedly.";
  }
  return `The bot's live view failed (${reason.details.code}): ${reason.details.reason}`;
}

function replayLastEventIntoCache(
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
  frame: Extract<BotSubscribeServerFrame, { kind: "snapshot" }>,
): void {
  const key = botQueryKeys.subscription(args);
  if (queryClient.getQueryData(key) !== undefined) return;
  queryClient.setQueryData(key, toSnapshot(frame));
}
