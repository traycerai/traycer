import { useCallback, useMemo } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  prSubscribeListForEpicServerFrameSchema,
  type PrLightItem,
  type PrSourceNotice,
  type PrSourceStatus,
  type PrSubscribeListForEpicMode,
  type PrSubscribeListForEpicServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import {
  resetSharedStreamSubscriptions,
  useSharedStreamSubscription,
  type SharedStreamSubscription,
  type SharedStreamSubscriptionRegistry,
} from "@/hooks/pr/shared-stream-subscription";

export interface PrListSubscriptionData {
  readonly sourceStatus: PrSourceStatus;
  /** Non-null while the host's fetch layer is paused for this GitHub host. */
  readonly notice: PrSourceNotice | null;
  readonly items: readonly PrLightItem[];
}

type PrListDataFrame = Extract<
  PrSubscribeListForEpicServerFrame,
  { kind: "snapshot" | "updated" }
>;
type PrListErrorFrame = Extract<
  PrSubscribeListForEpicServerFrame,
  { kind: "error" }
>;

export interface PrListSubscriptionResult {
  readonly data: PrListSubscriptionData | null;
  readonly error: PrListErrorFrame | null;
  readonly isPending: boolean;
  /** Sends the envelope-conformant `{kind:"refresh"}` client frame on this hook's own (host, epic, mode) session. No-op while disabled or before the session exists. */
  readonly sendRefresh: () => void;
}

interface ActiveSubscriptionArgs {
  readonly hostId: string;
  readonly epicId: string;
  readonly mode: PrSubscribeListForEpicMode;
}

type SharedSubscription =
  SharedStreamSubscription<PrSubscribeListForEpicServerFrame>;

/**
 * Module-level ref-counted subscriptions, keyed by the owning client
 * instance + `hostId` + `epicId` + `mode`. `mode` is part of the key (NOT
 * the cache key - see `prQueryKeys.listForEpic`) so a background session
 * (the epic shell's standing subscription) and a foreground session (the
 * panel) coexist as two independent transport lifecycles instead of one
 * collapsing into the other, per the tech plan's session-key rule.
 */
const subscriptions: SharedStreamSubscriptionRegistry<PrSubscribeListForEpicServerFrame> =
  new Map();

function subscriptionKeyFor(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.epicId}|${args.mode}`;
}

// Test helper to reset module state.
export function __resetPrListSubscriptionsForTesting(): void {
  resetSharedStreamSubscriptions(subscriptions);
}

export function usePrListSubscription(args: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly mode: PrSubscribeListForEpicMode;
  readonly enabled: boolean;
}): PrListSubscriptionResult {
  const queryClient = useQueryClient();
  const wsStreamClient = useWsStreamClient();

  const stableArgs: typeof args = useMemo(
    () => ({
      hostId: args.hostId,
      epicId: args.epicId,
      mode: args.mode,
      enabled: args.enabled,
    }),
    [args.hostId, args.epicId, args.mode, args.enabled],
  );

  // `null` while the key is unknowable. Note this does NOT fold in `enabled`:
  // a disabled hook still reads a sibling's live session for the same key.
  const activeArgs: ActiveSubscriptionArgs | null = useMemo(
    () =>
      stableArgs.hostId === null
        ? null
        : {
            hostId: stableArgs.hostId,
            epicId: stableArgs.epicId,
            mode: stableArgs.mode,
          },
    [stableArgs.hostId, stableArgs.epicId, stableArgs.mode],
  );
  const sessionKey =
    wsStreamClient === null || activeArgs === null
      ? null
      : subscriptionKeyFor(wsStreamClient, activeArgs);

  const createSession = useCallback((): SharedSubscription => {
    if (wsStreamClient === null || activeArgs === null) {
      throw new Error("A PR list session needs a client and a host.");
    }
    return createSharedSubscription(wsStreamClient, queryClient, activeArgs);
  }, [wsStreamClient, queryClient, activeArgs]);

  const onConsumerJoined = useCallback(
    (shared: SharedSubscription): void => {
      if (activeArgs === null) return;
      if (shared.lastEvent === null || shared.lastEvent.kind === "error") {
        return;
      }
      replayLastEventIntoCache(queryClient, activeArgs, shared.lastEvent);
    },
    [queryClient, activeArgs],
  );

  const { subscription, sendRefresh } = useSharedStreamSubscription({
    registry: subscriptions,
    sessionKey,
    enabled: stableArgs.enabled,
    consumerLabel: "pr-list-consumer",
    createSession,
    onConsumerJoined,
  });

  // Read current cache state via useQuery with disabled fetching. The
  // subscription effect above feeds cache updates, so this renders
  // reactively whenever the cache changes.
  const { data: queryData } = useQuery({
    ...queryOptions({
      queryKey: prQueryKeys.listForEpic({
        hostId: stableArgs.hostId,
        epicId: stableArgs.epicId,
      }),
      queryFn: (): Promise<PrListSubscriptionData | null> =>
        Promise.resolve(null),
      staleTime: Infinity,
    }),
    enabled: false,
  });

  const lastEvent = subscription?.lastEvent ?? null;
  const errorEvent = lastEvent?.kind === "error" ? lastEvent : null;
  const data = queryData ?? null;

  return {
    data,
    error: errorEvent,
    isPending: data === null && errorEvent === null,
    sendRefresh,
  };
}

function createSharedSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): SharedSubscription {
  const session = wsStreamClient.subscribe("pr.subscribeListForEpic", {
    epicId: args.epicId,
    mode: args.mode,
  });

  let sessionClosed = false;
  const shared: SharedSubscription = {
    refCount: 0,
    unsubscribeFromStream: () => {
      sessionClosed = true;
      session.close();
    },
    sendRefresh: () => {
      if (sessionClosed) return;
      session.sendClientFrame(
        { kind: "refresh", hasBinaryPayload: false },
        null,
      );
    },
    lastEvent: null,
    isTerminal: false,
    consumers: new Map(),
  };

  // Terminal teardown that keeps the map entry (and its error) alive for the
  // mounted consumers: the entry only leaves the map through the refCount
  // lifecycle, so a later fresh mount re-subscribes from scratch while the
  // current ones render the error instead of a forever-pending skeleton.
  const markTerminal = (frame: PrListErrorFrame): void => {
    sessionClosed = true;
    shared.isTerminal = true;
    session.close();
    shared.lastEvent = frame;
    for (const consumer of shared.consumers.values()) {
      consumer();
    }
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed) return;

    // Plain v1 stream: the frame's own fields ride directly on the envelope
    // (`streamMethodFrameEnvelopeSchema` is `.passthrough()`) - unlike git's
    // status stream, there is no host-specific `envelope.value` wrapping
    // here.
    const parseResult =
      prSubscribeListForEpicServerFrameSchema.safeParse(envelope);
    if (!parseResult.success) {
      return;
    }
    const frame = parseResult.data;

    if (frame.kind === "error") {
      if (frame.isFatal) {
        markTerminal(frame);
        return;
      }
      shared.lastEvent = frame;
      for (const consumer of shared.consumers.values()) {
        consumer();
      }
      return;
    }

    shared.lastEvent = frame;
    for (const consumer of shared.consumers.values()) {
      consumer();
    }
    writeIntoCache(queryClient, args, frame);
  });

  // Transport-terminal transitions (a fatal error frame, a closed client's
  // inert session, the no-progress UNAUTHORIZED give-up) never produce a
  // domain error frame - without this handler the subscription would sit in
  // a pending state forever.
  session.onStatusChange((status, reason) => {
    if (sessionClosed) return;
    if (status !== "closed") return;
    markTerminal({
      kind: "error",
      hasBinaryPayload: false,
      message: describeStreamClose(reason),
      isFatal: true,
    });
  });

  return shared;
}

function describeStreamClose(reason: StreamCloseReason | null): string {
  if (reason === null || reason.kind === "caller") {
    return "The Pull Requests stream closed unexpectedly.";
  }
  return `The Pull Requests stream failed (${reason.details.code}): ${reason.details.reason}`;
}

/**
 * The one frame-to-cache-value projection, so a new field on the frame cannot
 * reach the write path and be missed on the replay path (or the reverse).
 * `use-pr-detail-subscription.ts` carries the same helper.
 */
function toSubscriptionData(frame: PrListDataFrame): PrListSubscriptionData {
  return {
    sourceStatus: frame.sourceStatus,
    notice: frame.notice,
    items: frame.items,
  };
}

/**
 * Writes subscription frames into the TanStack Query cache.
 * Authorization: CLAUDE.md "Optimistic setQueryData is reserved for
 * response-equals-state cases". This call falls under that carve-out: the
 * host's `snapshot` / `updated` frames ARE the authoritative PR list state
 * at the moment they are emitted.
 */
function writeIntoCache(
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
  frame: PrListDataFrame,
): void {
  queryClient.setQueryData(
    prQueryKeys.listForEpic({ hostId: args.hostId, epicId: args.epicId }),
    toSubscriptionData(frame),
  );
}

/**
 * Re-applies a shared session's cached last frame to the query cache when a
 * NEW consumer joins an already-live session: an unobserved slot may have
 * been GC-collected since delivery, and the host sends no fresh hydration
 * snapshot to a session that never dropped its last subscriber. Refill-only:
 * a present value is always at least as fresh (this hook is the only
 * writer of this cache key).
 */
function replayLastEventIntoCache(
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
  frame: PrListDataFrame,
): void {
  const key = prQueryKeys.listForEpic({
    hostId: args.hostId,
    epicId: args.epicId,
  });
  if (queryClient.getQueryData(key) !== undefined) return;
  queryClient.setQueryData(key, toSubscriptionData(frame));
}
