import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  prSubscribeListForEpicServerFrameSchema,
  type PrLightItem,
  type PrSourceStatus,
  type PrSubscribeListForEpicMode,
  type PrSubscribeListForEpicServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";

export interface PrListSubscriptionData {
  readonly sourceStatus: PrSourceStatus;
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

interface SharedSubscription {
  refCount: number;
  unsubscribeFromStream: () => void;
  sendRefresh: () => void;
  lastEvent: PrSubscribeListForEpicServerFrame | null;
  // Set once the stream is terminal; its `sendRefresh` is then inert, so the
  // entry is REPLACED (not reused) on retry - see the subscribe effect.
  isTerminal: boolean;
  consumers: Map<symbol, () => void>;
}

/**
 * Module-level ref-counted subscriptions, keyed by the owning client
 * instance + `hostId` + `epicId` + `mode`. `mode` is part of the key (NOT
 * the cache key - see `prQueryKeys.listForEpic`) so a background session
 * (the epic shell's standing subscription) and a foreground session (the
 * panel) coexist as two independent transport lifecycles instead of one
 * collapsing into the other, per the tech plan's session-key rule.
 */
const subscriptions = new Map<string, SharedSubscription>();

function subscriptionKeyFor(
  client: WsStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.epicId}|${args.mode}`;
}

/** Render-time lookup of the shared entry this hook instance is attached to. */
function activeSubscriptionFor(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
  args: {
    readonly hostId: string | null;
    readonly epicId: string;
    readonly mode: PrSubscribeListForEpicMode;
  },
): SharedSubscription | undefined {
  if (client === null || args.hostId === null) {
    return undefined;
  }
  return subscriptions.get(
    subscriptionKeyFor(client, {
      hostId: args.hostId,
      epicId: args.epicId,
      mode: args.mode,
    }),
  );
}

// Test helper to reset module state.
export function __resetPrListSubscriptionsForTesting(): void {
  for (const sub of subscriptions.values()) {
    sub.unsubscribeFromStream();
  }
  subscriptions.clear();
}

export function usePrListSubscription(args: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly mode: PrSubscribeListForEpicMode;
  readonly enabled: boolean;
}): PrListSubscriptionResult {
  const queryClient = useQueryClient();
  const wsStreamClient = useWsStreamClient();
  // Re-render channel for subscription events that do NOT write the query
  // cache (fatal/non-fatal error frames, terminal closes). Cache-writing
  // frames re-render through `useQuery` below.
  const [, forceRender] = useReducer((renderCount: number) => {
    return renderCount + 1;
  }, 0);

  const stableArgs: typeof args = useMemo(
    () => ({
      hostId: args.hostId,
      epicId: args.epicId,
      mode: args.mode,
      enabled: args.enabled,
    }),
    [args.hostId, args.epicId, args.mode, args.enabled],
  );

  const [consumerId] = useState(() => Symbol("pr-list-consumer"));
  // Bumped by `retry()` to re-run the subscribe effect so a TERMINAL shared
  // session is replaced with a fresh one (its `sendRefresh` is inert).
  const [retryNonce, retry] = useReducer(
    (count: number): number => count + 1,
    0,
  );

  useEffect(() => {
    if (
      !stableArgs.enabled ||
      stableArgs.hostId === null ||
      wsStreamClient === null
    ) {
      return;
    }
    void retryNonce;

    const activeArgs: ActiveSubscriptionArgs = {
      hostId: stableArgs.hostId,
      epicId: stableArgs.epicId,
      mode: stableArgs.mode,
    };
    const key = subscriptionKeyFor(wsStreamClient, activeArgs);
    let shared = subscriptions.get(key);

    // Create fresh when there is none OR when the cached one is terminal, so a
    // retry actually reconnects instead of reusing a dead session.
    if (shared === undefined || shared.isTerminal) {
      shared?.unsubscribeFromStream();
      shared = createSharedSubscription(
        wsStreamClient,
        queryClient,
        activeArgs,
      );
      subscriptions.set(key, shared);
    }

    shared.refCount += 1;
    shared.consumers.set(consumerId, forceRender);

    // A second consumer joining an ALREADY-LIVE session (e.g. the same epic
    // open in two panes) gets no fresh hydration snapshot from the host - the
    // session never dropped to zero. Refill the cache slot if it was GC'd
    // while unobserved.
    if (shared.lastEvent !== null && shared.lastEvent.kind !== "error") {
      replayLastEventIntoCache(queryClient, activeArgs, shared.lastEvent);
    }

    return () => {
      shared.refCount -= 1;
      shared.consumers.delete(consumerId);

      // ADR-0003: no grace period - tear down immediately when ref count
      // reaches 0. Only delete the map slot if it still holds THIS entry - a
      // retry may have already replaced it with a fresh session.
      if (shared.refCount === 0) {
        shared.unsubscribeFromStream();
        if (subscriptions.get(key) === shared) subscriptions.delete(key);
      }
    };
  }, [stableArgs, queryClient, wsStreamClient, consumerId, retryNonce]);

  // Read current cache state via useQuery with disabled fetching. The
  // subscription effect above feeds cache updates, so this renders
  // reactively whenever the cache changes.
  const { data: queryData } = useQuery({
    ...queryOptions({
      queryKey: prQueryKeys.listForEpic(stableArgs.hostId, stableArgs.epicId),
      queryFn: (): Promise<PrListSubscriptionData | null> =>
        Promise.resolve(null),
      staleTime: Infinity,
    }),
    enabled: false,
  });

  const subscription = activeSubscriptionFor(wsStreamClient, stableArgs);
  const lastEvent = subscription?.lastEvent ?? null;
  const errorEvent = lastEvent?.kind === "error" ? lastEvent : null;
  const data = queryData ?? null;

  const sendRefresh = useCallback(() => {
    // A terminal session's `sendRefresh` is inert; a refresh there means
    // RECONNECT - re-run the effect to replace the dead entry. A live session
    // refreshes normally.
    if (errorEvent !== null) {
      retry();
      return;
    }
    activeSubscriptionFor(wsStreamClient, stableArgs)?.sendRefresh();
  }, [errorEvent, wsStreamClient, stableArgs]);

  return {
    data,
    error: errorEvent,
    isPending: data === null && errorEvent === null,
    sendRefresh,
  };
}

function createSharedSubscription(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
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
  queryClient.setQueryData(prQueryKeys.listForEpic(args.hostId, args.epicId), {
    sourceStatus: frame.sourceStatus,
    items: frame.items,
  } satisfies PrListSubscriptionData);
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
  const key = prQueryKeys.listForEpic(args.hostId, args.epicId);
  if (queryClient.getQueryData(key) !== undefined) return;
  queryClient.setQueryData(key, {
    sourceStatus: frame.sourceStatus,
    items: frame.items,
  } satisfies PrListSubscriptionData);
}
