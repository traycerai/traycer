import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  prSubscribeDetailServerFrameSchema,
  type PrActivitySection,
  type PrChecksSection,
  type PrCommitsSection,
  type PrDetailCore,
  type PrFilesSection,
  type PrLiveness,
  type PrSourceStatus,
  type PrSubscribeDetailServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";

export interface PrDetailSubscriptionData {
  readonly sourceStatus: PrSourceStatus;
  readonly liveness: PrLiveness;
  readonly core: PrDetailCore;
  readonly checks: PrChecksSection;
  readonly activity: PrActivitySection;
  readonly files: PrFilesSection;
  readonly commits: PrCommitsSection;
}

type PrDetailDataFrame = Extract<
  PrSubscribeDetailServerFrame,
  { kind: "snapshot" | "updated" }
>;
type PrDetailErrorFrame = Extract<
  PrSubscribeDetailServerFrame,
  { kind: "error" }
>;

export interface PrDetailSubscriptionResult {
  readonly data: PrDetailSubscriptionData | null;
  readonly error: PrDetailErrorFrame | null;
  readonly isPending: boolean;
  /** Sends the envelope-conformant `{kind:"refresh"}` client frame on this hook's own session. No-op while disabled or before the session exists. */
  readonly sendRefresh: () => void;
  /**
   * Whether the tile's BOUND host advertises `pr.subscribeDetail`. Read from
   * the same internally-resolved client the subscription itself uses (not
   * `useStreamMethodSupport`, which reads the app-wide DEFAULT host's client
   * - wrong client for a non-default-host tile). `null` while capability
   * negotiation hasn't completed yet; treated as supported until proven
   * otherwise, same as the panel's gate.
   */
  readonly methodSupported: boolean;
}

interface ActiveDetailSubscriptionArgs {
  readonly hostId: string;
  readonly epicId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}

interface SharedDetailSubscription {
  refCount: number;
  unsubscribeFromStream: () => void;
  sendRefresh: () => void;
  lastEvent: PrSubscribeDetailServerFrame | null;
  // Set once the stream reaches a terminal state (fatal frame or an
  // unexpected close). A terminal session's `sendRefresh` is inert, so the
  // entry must be REPLACED (not reused) on retry - see the subscribe effect.
  isTerminal: boolean;
  consumers: Map<symbol, () => void>;
}

/**
 * Module-level ref-counted subscriptions, keyed by the owning client
 * instance + the full authorization-relevant identity (`epicId` included -
 * the resolver authorizes the epic on EVERY subscribe open, so two tiles for
 * the same PR opened from different epics cannot share one session even
 * though the underlying host poller consolidates by PR key alone).
 */
const subscriptions = new Map<string, SharedDetailSubscription>();

function subscriptionKeyFor(
  client: WsStreamClient<HostStreamRpcRegistry>,
  args: ActiveDetailSubscriptionArgs,
): string {
  return [
    client.instanceId,
    args.epicId,
    args.githubHost,
    args.owner,
    args.repo,
    args.prNumber,
  ].join("|");
}

function activeSubscriptionFor(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
  args: {
    readonly hostId: string;
    readonly epicId: string;
    readonly githubHost: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  },
): SharedDetailSubscription | undefined {
  if (client === null) return undefined;
  return subscriptions.get(subscriptionKeyFor(client, args));
}

// Test helper to reset module state.
export function __resetPrDetailSubscriptionsForTesting(): void {
  for (const sub of subscriptions.values()) {
    sub.unsubscribeFromStream();
  }
  subscriptions.clear();
}

/**
 * Detail subscription for the PR full-view tile. Transport is resolved
 * INTERNALLY from `useTabHostId()` -> `useHostStreamClientFor` (with auth
 * revalidation), NOT from the app-wide default-host client: a tile bound to
 * a non-default host must subscribe through that host's own client, per
 * CLAUDE.md's tab-scoped host rule.
 */
export function usePrDetailSubscription(args: {
  readonly epicId: string;
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly enabled: boolean;
}): PrDetailSubscriptionResult {
  const queryClient = useQueryClient();
  const hostId = useTabHostId();
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const wsStreamClient = useHostStreamClientFor(target, auth);
  const methodSupport = useStreamMethodSupportFor(
    wsStreamClient,
    "pr.subscribeDetail",
  );
  const methodSupported = methodSupport !== "unsupported";

  const [, forceRender] = useReducer((renderCount: number) => {
    return renderCount + 1;
  }, 0);

  const stableArgs: typeof args & {
    readonly hostId: string;
    readonly methodSupported: boolean;
  } = useMemo(
    () => ({
      hostId,
      epicId: args.epicId,
      githubHost: args.githubHost,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      enabled: args.enabled,
      methodSupported,
    }),
    [
      hostId,
      args.epicId,
      args.githubHost,
      args.owner,
      args.repo,
      args.prNumber,
      args.enabled,
      methodSupported,
    ],
  );

  const [consumerId] = useState(() => Symbol("pr-detail-consumer"));
  // Bumped by `retry()` to force this consumer's subscribe effect to re-run so
  // a TERMINAL shared session is torn down and replaced with a fresh one.
  const [retryNonce, retry] = useReducer(
    (count: number): number => count + 1,
    0,
  );

  useEffect(() => {
    if (
      !stableArgs.enabled ||
      !stableArgs.methodSupported ||
      wsStreamClient === null
    ) {
      return;
    }
    void retryNonce;

    const activeArgs: ActiveDetailSubscriptionArgs = {
      hostId: stableArgs.hostId,
      epicId: stableArgs.epicId,
      githubHost: stableArgs.githubHost,
      owner: stableArgs.owner,
      repo: stableArgs.repo,
      prNumber: stableArgs.prNumber,
    };
    const key = subscriptionKeyFor(wsStreamClient, activeArgs);
    let shared = subscriptions.get(key);

    // Create a fresh session when there is none OR when the cached one is
    // terminal (its stream is dead and its `sendRefresh` is inert). Replacing a
    // terminal entry is what makes "Try again" actually reconnect instead of
    // spinning against a closed session.
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

    // A second consumer joining an ALREADY-LIVE session gets no fresh
    // hydration snapshot from the host - the session never dropped to zero.
    // Refill the cache slot if it was GC'd while unobserved.
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

  const { data: queryData } = useQuery({
    ...queryOptions({
      queryKey: prQueryKeys.detail({
        hostId: stableArgs.hostId,
        epicId: stableArgs.epicId,
        githubHost: stableArgs.githubHost,
        owner: stableArgs.owner,
        repo: stableArgs.repo,
        prNumber: stableArgs.prNumber,
      }),
      queryFn: (): Promise<PrDetailSubscriptionData | null> =>
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
    // After a terminal error the session is dead and its `sendRefresh` is a
    // no-op; a user "refresh"/"Try again" there means RECONNECT. Re-run the
    // subscribe effect (which replaces the terminal entry) instead of sending a
    // frame into a closed session. A live session refreshes as normal.
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
    methodSupported,
  };
}

function createSharedSubscription(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveDetailSubscriptionArgs,
): SharedDetailSubscription {
  const session = wsStreamClient.subscribe("pr.subscribeDetail", {
    epicId: args.epicId,
    githubHost: args.githubHost,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  });

  let sessionClosed = false;
  const shared: SharedDetailSubscription = {
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

  const markTerminal = (frame: PrDetailErrorFrame): void => {
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

    // Plain v1 stream: the frame's own fields ride directly on the envelope,
    // same convention as `pr.subscribeListForEpic`.
    const parseResult = prSubscribeDetailServerFrameSchema.safeParse(envelope);
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
    return "The PR detail stream closed unexpectedly.";
  }
  return `The PR detail stream failed (${reason.details.code}): ${reason.details.reason}`;
}

function toSubscriptionData(
  frame: PrDetailDataFrame,
): PrDetailSubscriptionData {
  return {
    sourceStatus: frame.sourceStatus,
    liveness: frame.liveness,
    core: frame.core,
    checks: frame.checks,
    activity: frame.activity,
    files: frame.files,
    commits: frame.commits,
  };
}

/**
 * Writes subscription frames into the TanStack Query cache. Authorization:
 * CLAUDE.md "Optimistic setQueryData is reserved for response-equals-state
 * cases" - the host's `snapshot`/`updated` frames ARE the authoritative PR
 * detail state at the moment they are emitted.
 */
function writeIntoCache(
  queryClient: QueryClient,
  args: ActiveDetailSubscriptionArgs,
  frame: PrDetailDataFrame,
): void {
  queryClient.setQueryData(
    prQueryKeys.detail({
      hostId: args.hostId,
      epicId: args.epicId,
      githubHost: args.githubHost,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
    }),
    toSubscriptionData(frame),
  );
}

/**
 * Re-applies a shared session's cached last frame to the query cache when a
 * NEW consumer joins an already-live session - see the list hook's identical
 * rationale.
 */
function replayLastEventIntoCache(
  queryClient: QueryClient,
  args: ActiveDetailSubscriptionArgs,
  frame: PrDetailDataFrame,
): void {
  const key = prQueryKeys.detail({
    hostId: args.hostId,
    epicId: args.epicId,
    githubHost: args.githubHost,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  });
  if (queryClient.getQueryData(key) !== undefined) return;
  queryClient.setQueryData(key, toSubscriptionData(frame));
}
