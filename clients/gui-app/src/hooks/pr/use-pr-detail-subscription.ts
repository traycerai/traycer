import { useCallback, useMemo } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
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
  type PrReviewThreadsSection,
  type PrSourceNotice,
  type PrSourceStatus,
  type PrSubscribeDetailServerFrame,
} from "@traycer/protocol/host/pr-schemas";
import { prQueryKeys } from "@/lib/query-keys/pr-query-keys";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import {
  resetSharedStreamSubscriptions,
  useSharedStreamSubscription,
  type SharedStreamSubscription,
  type SharedStreamSubscriptionRegistry,
} from "@/hooks/pr/shared-stream-subscription";

export interface PrDetailSubscriptionData {
  readonly sourceStatus: PrSourceStatus;
  /** Non-null while the host's fetch layer is paused for this GitHub host. */
  readonly notice: PrSourceNotice | null;
  readonly liveness: PrLiveness;
  readonly core: PrDetailCore;
  readonly checks: PrChecksSection;
  readonly activity: PrActivitySection;
  readonly reviewThreads: PrReviewThreadsSection;
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

type SharedDetailSubscription =
  SharedStreamSubscription<PrSubscribeDetailServerFrame>;

/**
 * Module-level ref-counted subscriptions, keyed by the owning client
 * instance + the full authorization-relevant identity (`epicId` included -
 * the resolver authorizes the epic on EVERY subscribe open, so two tiles for
 * the same PR opened from different epics cannot share one session even
 * though the underlying host poller consolidates by PR key alone).
 */
const subscriptions: SharedStreamSubscriptionRegistry<PrSubscribeDetailServerFrame> =
  new Map();

function subscriptionKeyFor(
  client: IHostStreamClient<HostStreamRpcRegistry>,
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

// Test helper to reset module state.
export function __resetPrDetailSubscriptionsForTesting(): void {
  resetSharedStreamSubscriptions(subscriptions);
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

  const activeArgs: ActiveDetailSubscriptionArgs = useMemo(
    () => ({
      hostId: stableArgs.hostId,
      epicId: stableArgs.epicId,
      githubHost: stableArgs.githubHost,
      owner: stableArgs.owner,
      repo: stableArgs.repo,
      prNumber: stableArgs.prNumber,
    }),
    [
      stableArgs.hostId,
      stableArgs.epicId,
      stableArgs.githubHost,
      stableArgs.owner,
      stableArgs.repo,
      stableArgs.prNumber,
    ],
  );
  // `null` only while there is no client to key against - NOT when this hook
  // instance is disabled, which still reads a sibling's live session.
  const sessionKey =
    wsStreamClient === null
      ? null
      : subscriptionKeyFor(wsStreamClient, activeArgs);

  const createSession = useCallback((): SharedDetailSubscription => {
    if (wsStreamClient === null) {
      throw new Error("A PR detail session needs a stream client.");
    }
    return createSharedSubscription(wsStreamClient, queryClient, activeArgs);
  }, [wsStreamClient, queryClient, activeArgs]);

  const onConsumerJoined = useCallback(
    (shared: SharedDetailSubscription): void => {
      if (shared.lastEvent === null || shared.lastEvent.kind === "error") {
        return;
      }
      replayLastEventIntoCache(queryClient, activeArgs, shared.lastEvent);
    },
    [queryClient, activeArgs],
  );

  const { lastEvent, sendRefresh } = useSharedStreamSubscription({
    registry: subscriptions,
    sessionKey,
    enabled: stableArgs.enabled && stableArgs.methodSupported,
    consumerLabel: "pr-detail-consumer",
    createSession,
    onConsumerJoined,
  });

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

  const errorEvent = lastEvent?.kind === "error" ? lastEvent : null;
  const data = queryData ?? null;

  return {
    data,
    error: errorEvent,
    isPending: data === null && errorEvent === null,
    sendRefresh,
    methodSupported,
  };
}

function createSharedSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
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
    const closeMessage = describeStreamClose(reason);
    // `null` means the close was retryable: the client is already reconnecting
    // and a fresh snapshot is coming, so marking the surface TERMINAL here
    // would turn ordinary reconnection into a dead panel.
    if (closeMessage === null) return;
    markTerminal({
      kind: "error",
      hasBinaryPayload: false,
      message: closeMessage,
      isFatal: true,
    });
  });

  return shared;
}

function describeStreamClose(reason: StreamCloseReason | null): string | null {
  // A RETRYABLE close is the transport reconnecting, not a failure the user
  // has to see: the client re-subscribes on its own backoff and the next
  // snapshot repopulates this surface. Returning `null` keeps the panel in
  // its pending state - "visibly retrying" - instead of flashing an error
  // that resolves itself, which is what an overnight sleep used to do to
  // every open panel at once.
  if (
    reason !== null &&
    reason.kind === "fatalError" &&
    reason.details.retryable === true
  ) {
    return null;
  }
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
    notice: frame.notice,
    liveness: frame.liveness,
    core: frame.core,
    checks: frame.checks,
    activity: frame.activity,
    reviewThreads: frame.reviewThreads,
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
