import {
  useCallback,
  useMemo,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  gitSubscribeStatusEventSchema,
  gitSubscribeStatusEventSchemaV11,
  gitSubscribeStatusEventSchemaV12,
  gitSubscribeStatusEventSchemaV13,
  type GitListChangedFilesResponse,
  type GitListChangedFilesResponseV11,
  type GitSubscribeStatusEvent,
  type GitSubscribeStatusEventV11,
  type GitSubscribeStatusEventV12,
  type GitSubscribeStatusEventV13,
  type GitWatcherStatus,
  type RepoMode,
  type RepoState,
} from "@traycer/protocol/host/git-schemas";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";
import {
  bumpRichSlotStreamGeneration,
  markRichSlotStreamRefill,
  richSlotOrderingKey,
} from "@/lib/git/git-rich-slot-ordering";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";

/** A delivered stream event: the frozen v1.0 frame when this connection negotiated minor 0 (or the version is unknown), the rich nested-snapshot frame when it negotiated minor >= 1. */
type GitSubscribeStatusStreamEvent =
  | GitSubscribeStatusEvent
  | GitSubscribeStatusEventV11
  | GitSubscribeStatusEventV12
  | GitSubscribeStatusEventV13;

export interface GitListChangedFilesSubscriptionResult {
  readonly data: GitListChangedFilesResponse | null;
  readonly error: GitSubscribeStatusEvent | null;
  readonly isPending: boolean;
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
  readonly pollStartedAtMs: number | null;
  /** Callers must treat `null` as "say nothing" - never as a green light. */
  readonly watcherStatus: GitWatcherStatus | null;
}

interface ActiveSubscriptionArgs {
  readonly hostId: string;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}

interface SharedSubscription {
  refCount: number;
  unsubscribeFromStream: () => void;
  lastEvent: GitSubscribeStatusStreamEvent | null;
  /** Watcher health from the last frame that carried it. Error frames must not clear it. */
  lastWatcherStatus: GitWatcherStatus | null;
  /** Version of the session that delivered the last frame, not the client-wide value. null before the first frame. */
  negotiatedVersion: SchemaVersion | null;
  /** Live session for this entry. Prefer over negotiatedVersion when sampling at will. */
  session: IStreamSession | null;
  /** Terminal close is not "no session yet". After terminal, do not fall back to the client-wide value (a sibling repo may still populate it). */
  terminated: boolean;
  consumers: Map<symbol, () => void>;
  sessionGeneration: number;
  closeCurrentSession: () => void;
  isRefreshing: boolean;
  refreshPromise: Promise<void> | null;
  settleRefresh: (() => void) | null;
  refreshTimeout: number | null;
}

interface GitSubscriptionRefreshStateArgs {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
}

interface ReplaceStreamSessionArgs {
  readonly shared: SharedSubscription;
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly args: ActiveSubscriptionArgs;
  readonly freshNonce: string | null;
}

interface NonceCorrelatedFrameHandlerArgs {
  /** Already parsed against the negotiated minor's schema. */
  readonly event: GitSubscribeStatusEventV12 | GitSubscribeStatusEventV13;
  readonly shared: SharedSubscription;
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly args: ActiveSubscriptionArgs;
  readonly awaitingFreshNonce: { current: string | null };
  readonly markTerminal: (event: GitSubscribeStatusEvent) => void;
}

/** The client instance is part of the key so a rebuilt `WsStreamClient` (host swap, sign-in change, liveness rebuild) can never be served a shared entry whose session belongs to a previous - possibly closed - client: every consumer's effect re-runs on the client change, drains the old entry to refCount 0 (tearing its session down), and opens a fresh entry against the new client. */
const subscriptions = new Map<string, SharedSubscription>();
const entryListeners = new Map<string, Set<() => void>>();

function subscriptionKeyFor(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.runningDir}|${args.ignoreWhitespace ? "1" : "0"}`;
}

/** Render-time lookup of the shared entry this hook instance is attached to. */
function activeSubscriptionFor(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
  args: {
    readonly hostId: string | null;
    readonly runningDir: string | null;
    readonly ignoreWhitespace: boolean;
  },
): SharedSubscription | undefined {
  if (client === null || args.hostId === null || args.runningDir === null) {
    return undefined;
  }
  return subscriptions.get(
    subscriptionKeyFor(client, {
      hostId: args.hostId,
      runningDir: args.runningDir,
      ignoreWhitespace: args.ignoreWhitespace,
    }),
  );
}

// Test helper to reset module state.
export function __resetSubscriptionsForTesting(): void {
  for (const sub of subscriptions.values()) {
    sub.unsubscribeFromStream();
  }
  subscriptions.clear();
  entryListeners.clear();
}

function entryKeyFor(args: GitSubscriptionRefreshStateArgs): string | null {
  if (
    args.wsStreamClient === null ||
    args.hostId === null ||
    args.runningDir === null
  ) {
    return null;
  }
  return subscriptionKeyFor(args.wsStreamClient, {
    hostId: args.hostId,
    runningDir: args.runningDir,
    ignoreWhitespace: args.ignoreWhitespace,
  });
}

/** `useSyncExternalStore` subscriber for one entry's change channel. */
function subscribeToEntry(
  key: string | null,
): (listener: () => void) => () => void {
  return (onStoreChange) => {
    if (key === null) return () => undefined;
    let listeners = entryListeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      entryListeners.set(key, listeners);
    }
    listeners.add(onStoreChange);
    return () => {
      const current = entryListeners.get(key);
      if (current === undefined) return;
      current.delete(onStoreChange);
      if (current.size === 0) entryListeners.delete(key);
    };
  };
}

/** Shared replacement state for every refresh surface addressing one stream. */
export function useGitSubscriptionRefreshState(
  args: GitSubscriptionRefreshStateArgs,
): boolean {
  const key = entryKeyFor(args);
  // Memoized on `key`: `useSyncExternalStore` compares the subscriber by reference, so a fresh closure each render tears the listener down and re-adds it every time - and because the unsubscribe drops the key once its set empties, the `Set` is rebuilt too.
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToEntry(key)(onStoreChange),
    [key],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      key === null ? false : (subscriptions.get(key)?.isRefreshing ?? false),
    () => false,
  );
}

/** Per-repo stream ownership of the rich slot. Client-wide getMethodSchemaVersion cannot answer this with two repos open. */
export function useGitSubscriptionOwnsRichSlot(
  args: GitSubscriptionRefreshStateArgs,
): boolean {
  const key = entryKeyFor(args);
  const client = args.wsStreamClient;
  // Subscribe to both the entry stamp and method-support handshake; dropping the latter leaves the unary query fetching until the first frame.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribeEntry = subscribeToEntry(key)(onStoreChange);
      const unsubscribeSupport =
        client === null
          ? () => undefined
          : client.subscribeMethodSupport(onStoreChange);
      return () => {
        unsubscribeEntry();
        unsubscribeSupport();
      };
    },
    [key, client],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      if (client === null) return false;
      const negotiated = entrySchemaVersion(
        key === null ? undefined : subscriptions.get(key),
        client,
      );
      return (
        negotiated !== null && negotiated.major === 1 && negotiated.minor >= 1
      );
    },
    () => false,
  );
}

/** Starts (or joins) the v1.2 fresh replacement for an already-observed stream. */
export function refreshGitSubscriptionWithFreshNonce(args: {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly queryClient: QueryClient;
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
}): Promise<void> | null {
  const client = args.wsStreamClient;
  if (client === null || args.hostId === null || args.runningDir === null) {
    return null;
  }
  const subscriptionArgs: ActiveSubscriptionArgs = {
    hostId: args.hostId,
    runningDir: args.runningDir,
    ignoreWhitespace: args.ignoreWhitespace,
  };
  const key = subscriptionKeyFor(client, subscriptionArgs);
  const shared = subscriptions.get(key);
  if (shared === undefined) return null;
  // Live session only, not entrySchemaVersion. A stamp or sibling-repo version would skip the unary fallback against a host that cannot echo the nonce.
  const version = shared.session?.getNegotiatedSchemaVersion() ?? null;
  if (version === null || version.major !== 1 || version.minor < 2) {
    return null;
  }
  if (shared.refreshPromise !== null) return shared.refreshPromise;

  const freshNonce = crypto.randomUUID();
  shared.isRefreshing = true;
  shared.refreshPromise = new Promise<void>((resolve) => {
    shared.settleRefresh = resolve;
  });
  notifyEntryChanged(key);
  replaceStreamSession({
    shared,
    wsStreamClient: client,
    queryClient: args.queryClient,
    args: subscriptionArgs,
    freshNonce,
  });
  shared.refreshTimeout = window.setTimeout(() => {
    settleSharedRefresh(shared, key);
  }, 10_000);
  return shared.refreshPromise;
}

export function useGitListChangedFilesSubscription(args: {
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): GitListChangedFilesSubscriptionResult {
  const queryClient = useQueryClient();
  const wsStreamClient = useWsStreamClient();
  // Re-render channel for subscription events that do NOT write the query cache (errors, terminal closes).
  // Cache-writing events re-render through `useQuery` below; invalidating a disabled query does not reliably notify observers, so events must not lean on invalidation for visibility.
  const [, forceRender] = useReducer((renderCount: number) => {
    return renderCount + 1;
  }, 0);

  // Memoize args to stabilize the reference for effect deps.
  // We reconstruct based on properties to avoid the linter complaint about args being a whole object.
  const stableArgs: typeof args = useMemo(
    () => ({
      hostId: args.hostId,
      runningDir: args.runningDir,
      ignoreWhitespace: args.ignoreWhitespace,
      enabled: args.enabled,
    }),
    [args.hostId, args.runningDir, args.ignoreWhitespace, args.enabled],
  );

  // Create a unique symbol for this hook instance to identify its consumer.
  const [consumerId] = useState(() =>
    Symbol("git-list-changed-files-consumer"),
  );

  // Local effect to manage this hook's subscription lifecycle.
  useEffect(() => {
    if (
      !stableArgs.enabled ||
      stableArgs.hostId === null ||
      stableArgs.runningDir === null ||
      wsStreamClient === null
    ) {
      return;
    }

    const activeArgs: ActiveSubscriptionArgs = {
      hostId: stableArgs.hostId,
      runningDir: stableArgs.runningDir,
      ignoreWhitespace: stableArgs.ignoreWhitespace,
    };
    const key = subscriptionKeyFor(wsStreamClient, activeArgs);
    let shared = subscriptions.get(key);

    if (shared === undefined) {
      shared = createSharedSubscription(
        wsStreamClient,
        queryClient,
        activeArgs,
      );
      subscriptions.set(key, shared);
      notifyEntryChanged(key);
    }

    // Increment ref count and register local consumer.
    shared.refCount += 1;
    shared.consumers.set(consumerId, forceRender);

    // the rich slot while only a diff tile - a v1-slot consumer - kept this shared session alive), and an unchanged repo produces no later fingerprint-gated frame to refill it.
    if (shared.lastEvent !== null) {
      replayLastEventIntoCache({
        shared,
        wsStreamClient,
        queryClient,
        args: activeArgs,
        event: shared.lastEvent,
      });
      forceRender();
    }

    // Cleanup on unmount.
    return () => {
      shared.refCount -= 1;
      shared.consumers.delete(consumerId);

      // ADR-0003: no grace period - tear down immediately when ref count reaches 0.
      if (shared.refCount === 0) {
        shared.unsubscribeFromStream();
        subscriptions.delete(key);
        notifyEntryChanged(key);
      }
    };
  }, [stableArgs, queryClient, wsStreamClient, consumerId]);

  // Read current cache state via useQuery with disabled fetching.
  // The subscription effect above feeds cache updates, so this renders
  // reactively whenever the cache changes.
  const { data: queryData } = useQuery({
    ...queryOptions({
      queryKey: gitQueryKeys.listChangedFiles(
        stableArgs.hostId ?? "",
        stableArgs.runningDir ?? "",
        stableArgs.ignoreWhitespace,
      ),
      queryFn: (): Promise<GitListChangedFilesResponse | null> =>
        Promise.resolve(null),
      staleTime: Infinity,
    }),
    enabled: false,
  });

  const subscription = activeSubscriptionFor(wsStreamClient, stableArgs);

  const frame = frameFacts(subscription);
  const data = queryData ?? null;

  return {
    data,
    error: frame.error,
    isPending: data === null && frame.error === null,
    repoState: data?.repoState ?? null,
    repoMode: data?.repoMode ?? null,
    pollStartedAtMs: frame.pollStartedAtMs,
    watcherStatus: frame.watcherStatus,
  };
}

/** The render-time reads off the shared entry, in one place. */
function frameFacts(subscription: SharedSubscription | undefined): {
  readonly error: GitSubscribeStatusEvent | null;
  readonly pollStartedAtMs: number | null;
  readonly watcherStatus: GitWatcherStatus | null;
} {
  const lastEvent = subscription?.lastEvent ?? null;
  return {
    error: lastEvent?.type === "error" ? lastEvent : null,
    pollStartedAtMs:
      lastEvent !== null && lastEvent.type !== "error"
        ? lastEvent.pollStartedAtMs
        : null,
    watcherStatus: subscription?.lastWatcherStatus ?? null,
  };
}

function createSharedSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): SharedSubscription {
  const shared: SharedSubscription = {
    refCount: 0,
    unsubscribeFromStream: () => undefined,
    lastEvent: null,
    lastWatcherStatus: null,
    negotiatedVersion: null,
    session: null,
    terminated: false,
    consumers: new Map(),
    sessionGeneration: 0,
    closeCurrentSession: () => undefined,
    isRefreshing: false,
    refreshPromise: null,
    settleRefresh: null,
    refreshTimeout: null,
  };
  const key = subscriptionKeyFor(wsStreamClient, args);
  shared.unsubscribeFromStream = () => {
    shared.sessionGeneration += 1;
    shared.closeCurrentSession();
    settleSharedRefresh(shared, key);
  };
  replaceStreamSession({
    shared,
    wsStreamClient,
    queryClient,
    args,
    freshNonce: null,
  });
  return shared;
}

/** Write lastWatcherStatus on every non-error frame, including missing watcher (null). Error frames must not clear it. */
function recordDeliveredFrame(
  shared: SharedSubscription,
  event: GitSubscribeStatusStreamEvent,
): void {
  shared.lastEvent = event;
  if (event.type === "error") return;
  shared.lastWatcherStatus = "watcher" in event ? event.watcher : null;
}

/** Source the version from the session that delivered the frame, never getMethodSchemaVersion. Unknown/null is frozen v1.0, never the client-wide value. */
function frameTierOf(
  negotiated: SchemaVersion | null,
): "v13" | "v12" | "rich" | "frozen" {
  if (negotiated === null || negotiated.major !== 1) return "frozen";
  if (negotiated.minor >= 3) return "v13";
  if (negotiated.minor >= 2) return "v12";
  if (negotiated.minor >= 1) return "rich";
  return "frozen";
}

/** Publish at handshake and every delivery. The client-wide change signal cannot stand in (sibling repos). */
function publishNegotiatedVersion(
  shared: SharedSubscription,
  negotiated: SchemaVersion | null,
  key: string,
): void {
  if (sameSchemaVersion(shared.negotiatedVersion, negotiated)) return;
  shared.negotiatedVersion = negotiated;
  notifyEntryChanged(key);
}

function sameSchemaVersion(
  left: SchemaVersion | null,
  right: SchemaVersion | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.major === right.major && left.minor === right.minor;
}

/** Ownership: live session, then stamp, then client-wide. Do not use this to authorize an action; a stamp is a handshake that has already ended. */
function entrySchemaVersion(
  shared: SharedSubscription | undefined,
  client: IHostStreamClient<HostStreamRpcRegistry>,
): SchemaVersion | null {
  // A dead stream owns nothing, and says so instead of deferring. Everything
  // below this line describes a stream that may still write.
  if (shared?.terminated === true) return null;
  const live = shared?.session?.getNegotiatedSchemaVersion() ?? null;
  if (live !== null) return live;
  const stamped = shared?.negotiatedVersion ?? null;
  if (stamped !== null) return stamped;
  return client.getMethodSchemaVersion("git.subscribeStatus");
}

function replaceStreamSession(opts: ReplaceStreamSessionArgs): void {
  const { shared, wsStreamClient, queryClient, args, freshNonce } = opts;
  const entryKey = subscriptionKeyFor(wsStreamClient, args);
  // Retire the old generation BEFORE close. A synchronous close callback is
  // then ignored and cannot publish a terminal error over the preserved cache.
  shared.sessionGeneration += 1;
  const generation = shared.sessionGeneration;
  // Watcher health belongs to the session that reported it.
  shared.lastWatcherStatus = null;
  // Same reasoning for the stamped version: it describes the session being
  // retired. Holding it across the replacement would answer for a session that
  // is gone, which is the whole failure mode the stamp exists to end.
  shared.negotiatedVersion = null;
  // Clearing the field is not enough on its own - the render-time value is read
  // through the store snapshot, so without a notify the notice stays on screen
  // until some later frame happens to publish.
  notifyConsumers(shared);
  shared.closeCurrentSession();
  const session = wsStreamClient.subscribe("git.subscribeStatus", {
    hostId: args.hostId,
    runningDir: args.runningDir,
    ignoreWhitespace: args.ignoreWhitespace,
    freshNonce,
  });
  shared.session = session;
  // A new session means this entry is live again, whatever became of the last.
  shared.terminated = false;
  let sessionClosed = false;
  shared.closeCurrentSession = () => {
    sessionClosed = true;
    session.close();
    // Only ever clears the handle it installed: `replaceStreamSession` may
    // already have swapped a newer session in, and dropping that one would
    // send every entry-scoped reader back to the client-wide value.
    if (shared.session === session) shared.session = null;
  };
  const awaitingFreshNonce = { current: freshNonce };

  // Terminal teardown that keeps the map entry (and its error) alive for the mounted consumers: the entry only leaves the map through the refCount lifecycle, so a later fresh mount re-subscribes from scratch while the current ones render the error instead of a forever-pending skeleton.
  const markTerminal = (event: GitSubscribeStatusEvent): void => {
    if (generation !== shared.sessionGeneration) return;
    sessionClosed = true;
    session.close();
    shared.lastEvent = event;
    // Terminal teardown DROPS watcher health, unlike a non-fatal error frame which preserves it.
    shared.lastWatcherStatus = null;
    // Drop both the closed session and its stamp. `close()` does not clear the last-negotiated minor; leaving it claims stream ownership with no writer.
    shared.session = null;
    shared.negotiatedVersion = null;
    shared.terminated = true;
    settleSharedRefresh(shared, entryKey);
    notifyEntryChanged(entryKey);
    notifyConsumers(shared);
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed || generation !== shared.sessionGeneration) return;

    // The negotiated version is read AT DELIVERY TIME (never from a render-stale closure): the handshake can settle after the subscribe, and ownership of the rich slot must flip with the version, not with a React render.
    const negotiated = session.getNegotiatedSchemaVersion();
    publishNegotiatedVersion(shared, negotiated, entryKey);
    const tier = frameTierOf(negotiated);
    const v13Frames = tier === "v13";
    const v12Frames = tier === "v13" || tier === "v12";
    const richFrames = v12Frames || tier === "rich";

    // Server wraps the event as `envelope.value` per the host's SendServerFrame contract (see git-stream-resolvers.ts).
    if (v12Frames) {
      // `watcher` is required at v1.3 on the delivering session. A frame without it is malformed; do not re-parse as v1.2.
      const parsed = v13Frames
        ? gitSubscribeStatusEventSchemaV13.safeParse(envelope.value)
        : gitSubscribeStatusEventSchemaV12.safeParse(envelope.value);
      if (!parsed.success) {
        // Never `parsed.error` or `envelope.value`: git frames carry file paths and repository content.
        const issuePaths = parsed.error.issues
          .map((issue) =>
            issue.path.length > 0 ? issue.path.join(".") : "(root)",
          )
          .join(", ");
        console.warn(
          `[stream] git.subscribeStatus frame failed schema validation (tier=${tier}, issues=[${issuePaths}]); dropping frame`,
        );
        return;
      }
      handleNonceCorrelatedFrame({
        event: parsed.data,
        shared,
        wsStreamClient,
        queryClient,
        args,
        awaitingFreshNonce,
        markTerminal,
      });
      return;
    }

    if (richFrames) {
      const parseResult = gitSubscribeStatusEventSchemaV11.safeParse(
        envelope.value,
      );
      if (!parseResult.success) {
        return;
      }
      const event = parseResult.data;
      if (event.type === "error" && event.isFatal) {
        markTerminal(event);
        return;
      }
      recordDeliveredFrame(shared, event);
      notifyConsumers(shared);
      writeRichEventIntoCache(queryClient, args, event, {
        parentSlotWrite: "always",
        richSlotWrite: "always",
        invalidateDiffs: true,
      });
      return;
    }

    const parseResult = gitSubscribeStatusEventSchema.safeParse(envelope.value);
    if (!parseResult.success) {
      return;
    }
    const event = parseResult.data;

    if (event.type === "error" && event.isFatal) {
      markTerminal(event);
      return;
    }

    recordDeliveredFrame(shared, event);
    notifyConsumers(shared);

    // It must never touch the rich slot: in this state the unary+timer pair owns it, and a v1.1 parser default (`submodules: []`) would clobber the unary-fed cache.
    writeIntoCache(queryClient, args, event, {
      parentSlotWrite: "always",
      invalidateDiffs: true,
    });
  });

  // Transport-terminal transitions (a fatal error frame, a closed client's inert session, the no-progress UNAUTHORIZED give-up) never produce a domain error frame - without this handler the subscription would sit in a pending state forever (the stuck git-diff skeleton incident).
  session.onStatusChange((status, reason) => {
    if (sessionClosed || generation !== shared.sessionGeneration) return;
    if (status === "open") {
      // The handshake has settled, so this session finally knows its own minor.
      // Publishing here is what makes ownership correct BEFORE the first frame.
      publishNegotiatedVersion(
        shared,
        session.getNegotiatedSchemaVersion(),
        entryKey,
      );
      return;
    }
    if (status === "reconnecting") {
      // Recoverable drop never reaches `"closed"`; clear the degraded value or the panel keeps stating it through backoff with no frame to contradict it.
      if (shared.lastWatcherStatus !== null) {
        shared.lastWatcherStatus = null;
        notifyConsumers(shared);
      }
      return;
    }
    if (status !== "closed") return;
    const closeMessage = describeStreamClose(reason);
    // `null` means the close was retryable: the client is already reconnecting
    // and a fresh snapshot is coming, so marking the surface TERMINAL here
    // would turn ordinary reconnection into a dead panel.
    if (closeMessage === null) return;
    markTerminal({
      type: "error",
      message: closeMessage,
      isFatal: true,
    });
  });
}

/** Shared by minors 2 and 3: both carry `freshNonce`, so the replacement correlation is identical. */
function handleNonceCorrelatedFrame(
  args: NonceCorrelatedFrameHandlerArgs,
): void {
  const event = args.event;
  if (event.type === "error" && event.isFatal) {
    args.markTerminal(event);
    return;
  }
  if (args.awaitingFreshNonce.current !== null) {
    if (
      event.type !== "snapshot" ||
      event.freshNonce !== args.awaitingFreshNonce.current
    ) {
      return;
    }
    args.awaitingFreshNonce.current = null;
    settleSharedRefresh(
      args.shared,
      subscriptionKeyFor(args.wsStreamClient, args.args),
    );
  }
  recordDeliveredFrame(args.shared, event);
  notifyConsumers(args.shared);
  writeRichEventIntoCache(args.queryClient, args.args, event, {
    parentSlotWrite: "always",
    richSlotWrite: "always",
    invalidateDiffs: true,
  });
}

function settleSharedRefresh(shared: SharedSubscription, key: string): void {
  if (shared.refreshTimeout !== null) {
    clearTimeout(shared.refreshTimeout);
    shared.refreshTimeout = null;
  }
  const settle = shared.settleRefresh;
  shared.settleRefresh = null;
  shared.refreshPromise = null;
  if (!shared.isRefreshing && settle === null) return;
  shared.isRefreshing = false;
  settle?.();
  notifyEntryChanged(key);
}

function notifyEntryChanged(key: string): void {
  for (const listener of entryListeners.get(key) ?? []) listener();
}

function notifyConsumers(shared: SharedSubscription): void {
  for (const consumer of shared.consumers.values()) consumer();
}

function describeStreamClose(reason: StreamCloseReason | null): string | null {
  // A RETRYABLE close is the transport reconnecting, not a failure the user has to see: the client re-subscribes on its own backoff and the next snapshot repopulates this surface.
  if (
    reason !== null &&
    reason.kind === "fatalError" &&
    reason.details.retryable === true
  ) {
    return null;
  }
  if (reason === null || reason.kind === "caller") {
    return "The Git changes stream closed unexpectedly.";
  }
  return `The Git changes stream failed (${reason.details.code}): ${reason.details.reason}`;
}

/**
 * Host `snapshot`/`updated` events are the working tree; write them into the query cache.
 */
function writeIntoCache(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly runningDir: string | null;
    readonly ignoreWhitespace: boolean;
  },
  event: GitSubscribeStatusEvent,
  opts: {
    readonly parentSlotWrite: "always" | "ifAbsent";
    readonly invalidateDiffs: boolean;
  },
): void {
  if (event.type === "error") {
    return;
  }

  if (args.runningDir === null) {
    return;
  }

  // A REPLAY ("ifAbsent") must not roll the v1.0 slot backward either: a
  // manual worktree-status refresh may have written a NEWER unary response
  // since this event was cached (`use-git-refresh-worktree-status.ts`).
  if (
    opts.parentSlotWrite === "ifAbsent" &&
    queryClient.getQueryData(
      gitQueryKeys.listChangedFiles(
        args.hostId,
        args.runningDir,
        args.ignoreWhitespace,
      ),
    ) !== undefined
  ) {
    return;
  }

  writeGitListChangedFilesResponse(
    queryClient,
    {
      hostId: args.hostId,
      runningDir: args.runningDir,
      ignoreWhitespace: args.ignoreWhitespace,
    },
    {
      runningDir: event.runningDir,
      headSha: event.headSha,
      branch: event.branch,
      files: event.files,
      fingerprint: event.fingerprint,
      repoMode: event.repoMode,
      repoState: event.repoState,
    },
  );

  if (
    opts.invalidateDiffs &&
    event.type === "updated" &&
    event.changedPaths.length > 0
  ) {
    // ADR-0004: Per-path invalidation for changed files.
    invalidateChangedFileDiffs(queryClient, args.hostId, [
      { runningDir: args.runningDir, changedPaths: event.changedPaths },
    ]);
  }
}

/** Replay never writes a unary-owned rich slot and never re-invalidates diffs.
 * Replay ifAbsent refills a GC-collected rich slot only; never supersedes newer unary data. */
function writeRichEventIntoCache(
  queryClient: QueryClient,
  args: {
    readonly hostId: string | null;
    readonly runningDir: string | null;
    readonly ignoreWhitespace: boolean;
  },
  event: GitSubscribeStatusEventV11,
  opts: {
    readonly parentSlotWrite: "always" | "ifAbsent";
    readonly richSlotWrite: "always" | "ifAbsent" | "never";
    readonly invalidateDiffs: boolean;
  },
): void {
  if (event.type === "error") {
    return;
  }
  if (args.runningDir === null) {
    return;
  }

  // Same replay protection as `writeIntoCache`: a manual worktree-status
  // refresh may have written a newer unary response into the v1.0 slot.
  const shouldWriteParentSlot =
    opts.parentSlotWrite === "always" ||
    queryClient.getQueryData(
      gitQueryKeys.listChangedFiles(
        args.hostId,
        args.runningDir,
        args.ignoreWhitespace,
      ),
    ) === undefined;
  if (shouldWriteParentSlot) {
    const projectedFiles = event.files.map(
      ({ gitlink: _gitlink, ...v10Fields }) => v10Fields,
    );
    writeGitListChangedFilesResponse(
      queryClient,
      {
        hostId: args.hostId,
        runningDir: args.runningDir,
        ignoreWhitespace: args.ignoreWhitespace,
      },
      {
        runningDir: event.runningDir,
        headSha: event.headSha,
        branch: event.branch,
        files: projectedFiles,
        fingerprint: event.fingerprint,
        repoMode: event.repoMode,
        repoState: event.repoState,
      },
    );
  }

  const richSlotKey = gitQueryKeys.listChangedFilesWithSubmodules(
    args.hostId,
    args.runningDir,
    args.ignoreWhitespace,
  );
  const shouldWriteRichSlot =
    opts.richSlotWrite === "always" ||
    (opts.richSlotWrite === "ifAbsent" &&
      queryClient.getQueryData(richSlotKey) === undefined);
  if (shouldWriteRichSlot) {
    const submodules =
      event.type === "updated"
        ? event.submodules.map(
            ({ changedPaths: _changedPaths, ...section }) => {
              return section;
            },
          )
        : event.submodules;
    const richResponse: GitListChangedFilesResponseV11 = {
      runningDir: event.runningDir,
      headSha: event.headSha,
      branch: event.branch,
      files: [...event.files],
      fingerprint: event.nestedFingerprint,
      repoMode: event.repoMode,
      repoState: event.repoState,
      submodules,
    };
    queryClient.setQueryData(richSlotKey, richResponse);
    const orderingKey = richSlotOrderingKey({
      hostId: args.hostId,
      runningDir: args.runningDir,
      ignoreWhitespace: args.ignoreWhitespace,
    });
    if (opts.richSlotWrite === "always") {
      bumpRichSlotStreamGeneration(orderingKey);
    } else {
      markRichSlotStreamRefill(orderingKey);
    }
  }

  if (opts.invalidateDiffs && event.type === "updated") {
    const scopes = [
      { runningDir: args.runningDir, changedPaths: event.changedPaths },
      ...event.submodules.map((section) => ({
        runningDir: section.repoRoot,
        changedPaths: section.changedPaths,
      })),
    ].filter((scope) => scope.changedPaths.length > 0);
    invalidateChangedFileDiffs(queryClient, args.hostId, scopes);
  }
}

/**
 * Replay the shared session's last event when a new consumer joins. Ownership is who writes the rich slot now, not a tier recorded on the event.
 */
function replayLastEventIntoCache(opts: {
  readonly shared: SharedSubscription;
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly args: ActiveSubscriptionArgs;
  readonly event: GitSubscribeStatusStreamEvent;
}): void {
  const { shared, wsStreamClient, queryClient, args, event } = opts;
  if (event.type === "error") {
    return;
  }
  if ("nestedFingerprint" in event) {
    const negotiated = entrySchemaVersion(shared, wsStreamClient);
    const richOwned =
      negotiated !== null && negotiated.major === 1 && negotiated.minor >= 1;
    writeRichEventIntoCache(queryClient, args, event, {
      // Refill-only on BOTH slots: a PRESENT value may be newer than this
      // cached event (a manual unary refresh accepted after it) and must win.
      parentSlotWrite: "ifAbsent",
      richSlotWrite: richOwned ? "ifAbsent" : "never",
      invalidateDiffs: false,
    });
    return;
  }
  writeIntoCache(queryClient, args, event, {
    parentSlotWrite: "ifAbsent",
    invalidateDiffs: false,
  });
}

/** ADR-0004 per-path diff invalidation across one or more repo roots (the parent worktree and, on rich frames, each submodule root). */
function invalidateChangedFileDiffs(
  queryClient: QueryClient,
  hostId: string | null,
  scopes: ReadonlyArray<{
    readonly runningDir: string;
    readonly changedPaths: readonly string[];
  }>,
): void {
  if (scopes.length === 0) {
    return;
  }
  const changedSets = scopes.map((scope) => ({
    runningDir: scope.runningDir,
    changedSet: new Set<string>(scope.changedPaths),
  }));
  void queryClient.invalidateQueries({
    predicate: (query) =>
      changedSets.some(({ runningDir, changedSet }) =>
        gitQueryKeys.matchFileDiff(
          query.queryKey,
          hostId,
          runningDir,
          changedSet,
        ),
      ),
  });
}
