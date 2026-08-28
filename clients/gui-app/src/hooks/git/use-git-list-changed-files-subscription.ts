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

/**
 * A delivered stream event: the frozen v1.0 frame when this connection
 * negotiated minor 0 (or the version is unknown), the rich nested-snapshot
 * frame when it negotiated minor >= 1. The `error` variant is identical on
 * both minors.
 */
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
  /**
   * Whether the host is watching the filesystem for this repo or has fallen
   * back to periodic polling. `null` means UNKNOWN, not healthy: the host
   * negotiated a minor below 1.3, or no frame has arrived yet. Callers must
   * treat `null` as "say nothing" - never as a green light.
   */
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
  /**
   * Watcher health from the last frame that CARRIED it - deliberately not
   * derived from `lastEvent`.
   *
   * Error frames carry no watcher field, and a git-compute failure is not
   * evidence the watcher recovered or died. Reading this off `lastEvent` made
   * the notice vanish for the duration of a non-fatal git error - exactly when
   * the panel is showing stale data and the user most wants to know why.
   */
  lastWatcherStatus: GitWatcherStatus | null;
  /**
   * The version negotiated by the session that delivered the last frame - NOT
   * the client-wide value, which describes whichever stream for this method
   * `reconcileMethodSchemaVersion` reached first and can therefore belong to
   * another repo entirely.
   *
   * `null` before the first frame; ownership readers fall back past it (see
   * `entrySchemaVersion`), which is today's behaviour exactly, so the stamp can
   * only ever improve on it. The host forces an immediate tick for a new
   * subscriber and replays its cached snapshot, so that window is one frame
   * wide even on a repo that never changes.
   */
  negotiatedVersion: SchemaVersion | null;
  /**
   * The session currently bound to this entry, so a reader with no session of
   * its own can still ask THE RIGHT ONE rather than the client-wide value.
   * Preferred over `negotiatedVersion` wherever the caller can sample at will:
   * it is live, so a renegotiation is visible immediately instead of at the
   * next delivered frame.
   */
  session: IStreamSession | null;
  /**
   * Whether this entry's stream has gone TERMINAL - distinct from "no session
   * yet", and they must fall back differently.
   *
   * Before a first handshake, deferring to the client-wide value is right: this
   * stream is about to negotiate and fill the slot, so handing ownership to the
   * unary query would buy a redundant fetch on every mount to close a window
   * the first frame closes anyway.
   *
   * After a terminal close nothing will ever arrive again, and the client-wide
   * value is NOT empty just because this session died - a sibling repo's live
   * stream keeps it populated. Falling back there would report an owner that
   * cannot write, leaving the panel with no writer at all.
   */
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

/**
 * Module-level ref-counted subscriptions, keyed by the OWNING CLIENT INSTANCE
 * plus the subscription params. The client instance is part of the key so a
 * rebuilt `WsStreamClient` (host swap, sign-in change, liveness rebuild) can
 * never be served a shared entry whose session belongs to a previous - possibly
 * closed - client: every consumer's effect re-runs on the client change, drains
 * the old entry to refCount 0 (tearing its session down), and opens a fresh
 * entry against the new client.
 */
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
  // Close and clear all subscriptions.
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
  // Memoized on `key`: `useSyncExternalStore` compares the subscriber by
  // reference, so a fresh closure each render tears the listener down and
  // re-adds it every time - and because the unsubscribe drops the key once its
  // set empties, the `Set` is rebuilt too. Matches
  // `useGitSubscriptionOwnsRichSlot` below.
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

/**
 * Whether the stream owns the rich slot FOR THIS REPO - the reactive read the
 * unary nested-snapshot query disables itself on.
 *
 * Worktree-scoped by construction, which is the point. The client-wide
 * `getMethodSchemaVersion` cannot answer this: with two repos open, repo A
 * negotiating >= 1.1 would disable repo B's unary query, and if B's own session
 * is at 1.0 the stream never writes B's rich slot either - leaving that panel
 * with no writer at all.
 *
 * Reactive through the entry's change channel, which delivery notifies when the
 * stamp moves. Before the first frame this falls back to the client-wide value
 * (see `entrySchemaVersion`), so a cold mount behaves exactly as it did before
 * the stamp existed.
 */
export function useGitSubscriptionOwnsRichSlot(
  args: GitSubscriptionRefreshStateArgs,
): boolean {
  const key = entryKeyFor(args);
  const client = args.wsStreamClient;
  // BOTH signals, deliberately. The entry channel carries the stamp, but the
  // stamp only lands with the first frame; `subscribeMethodSupport` is what
  // re-renders when the handshake settles, which is when the fallback value
  // this hook starts on becomes meaningful. Dropping it would leave the unary
  // query enabled - and fetching - until the first frame on every mount.
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

/**
 * Starts (or joins) the v1.2 fresh replacement for an already-observed stream.
 * `null` tells callers to retain their negotiated-minor <=1 unary fallback.
 */
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
  // The LIVE session only - not `entrySchemaVersion`. This gate is unlike the
  // other two entry-scoped reads: they answer "who owns this slot", where
  // holding the last known value through a blip beats thrashing ownership.
  // This one authorizes an ACTION against whatever session exists right now,
  // and a stamp is evidence about a handshake that has already ended.
  //
  // Both stale sources fail the same way. A sibling repo at 1.2 (the
  // client-wide value) or this stream's own previous handshake (the stamp)
  // would authorize a fresh-nonce replacement whose peer may be a restarted,
  // rolled-back v1.1 host that cannot echo the nonce. The caller reads a
  // non-null return as "the stream is handling it" and skips its unary
  // fallback, so the refresh the user asked for never happens and they wait
  // out the 10s timeout instead.
  //
  // `null` here (no handshake yet, or between connections) correctly declines
  // and lets the caller do a plain unary refresh.
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
  // Re-render channel for subscription events that do NOT write the query
  // cache (errors, terminal closes). Cache-writing events re-render through
  // `useQuery` below; invalidating a disabled query does not reliably notify
  // observers, so events must not lean on invalidation for visibility.
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

    // If we have a cached event, deliver it immediately - re-applying the
    // CACHE WRITES, not just re-rendering: an unobserved query slot may have
    // been GC-collected since the event was delivered (e.g. the rich slot
    // while only a diff tile - a v1-slot consumer - kept this shared session
    // alive), and an unchanged repo produces no later fingerprint-gated frame
    // to refill it. Slot writes only; per-path diff invalidation is not
    // replayed for a frame that already invalidated on delivery.
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

/**
 * The render-time reads off the shared entry, in one place.
 *
 * Note the asymmetry, which is the point: `error` and `pollStartedAtMs` come
 * from the LAST frame, while `watcherStatus` comes from the last frame that
 * actually carried watcher health. Error frames carry none, and a git-compute
 * failure is not evidence about the watcher - see `lastWatcherStatus`.
 */
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

/**
 * Records a NON-TERMINAL delivered frame on the shared entry.
 *
 * `lastWatcherStatus` is written on every non-error frame, including frames
 * that carry no `watcher` field - those set it back to `null` (UNKNOWN). It is
 * tempting to only write when the field is present, but that turns the value
 * into a latch: a connection that renegotiates DOWN from 1.3 (the same client
 * instance reconnecting to a restarted or rolled-back host, which
 * `WsStreamClient` treats as a possible new incarnation) would keep showing a
 * degraded notice sourced from a host generation that no longer exists, with
 * no event able to clear it.
 *
 * Error frames are the deliberate exception and never reach here for the
 * watcher: they carry no watcher field, but a git-compute failure is not
 * evidence the watcher changed, so the previous value must survive them.
 */
function recordDeliveredFrame(
  shared: SharedSubscription,
  event: GitSubscribeStatusStreamEvent,
): void {
  shared.lastEvent = event;
  if (event.type === "error") return;
  shared.lastWatcherStatus = "watcher" in event ? event.watcher : null;
}

/**
 * Which frame shape a negotiated version corresponds to, as one value instead
 * of a ladder of independent booleans.
 *
 * Callers must source that version from the SESSION that delivered the frame,
 * never from the client-wide `getMethodSchemaVersion` - with two repos open on
 * one client the latter can report the sibling stream's minor (see
 * `IStreamSession.getNegotiatedSchemaVersion`). Parsing repo A's frame at repo
 * B's minor silently strips fields A's host did send, or demands fields B's
 * host cannot send.
 *
 * Unknown or non-major-1 collapses to the FROZEN v1.0 tier, which is the only
 * safe default: a client that guessed high would parse with a schema the peer
 * never agreed to and could write fields into the rich slot the host does not
 * own on that connection. `null` (no handshake yet) takes that same default -
 * never the client-wide value, which is the skew this function exists to avoid.
 */
function frameTierOf(
  negotiated: SchemaVersion | null,
): "v13" | "v12" | "rich" | "frozen" {
  if (negotiated === null || negotiated.major !== 1) return "frozen";
  if (negotiated.minor >= 3) return "v13";
  if (negotiated.minor >= 2) return "v12";
  if (negotiated.minor >= 1) return "rich";
  return "frozen";
}

/**
 * Records this session's negotiated version on the entry and wakes the readers
 * that have no session of their own.
 *
 * Called at BOTH the handshake and every delivery, and the handshake is the one
 * that is easy to miss. The client-wide change signal cannot stand in for it:
 * `reconcileMethodSchemaVersion` answers with whichever session it reaches
 * first, so a sibling repo already holding the value means this session
 * negotiating something different moves nothing and notifies nobody. The
 * snapshot would be right the moment anything asked - and nothing would ask
 * until this stream's first frame, which on a slow initial scan is a long time
 * to render from a sibling's minor.
 */
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

/**
 * The version to answer an OWNERSHIP question about THIS repo's stream with -
 * "who writes this slot" - in falling order of authority: the live session, the
 * last delivered stamp, the client-wide value.
 *
 * NOT for authorizing an action. `refreshGitSubscriptionWithFreshNonce` reads
 * the live session directly and declines when it is `null`, because a stamp is
 * evidence about a handshake that has already ended, and acting on it commits
 * the caller to a stream that may no longer be able to honour it. Ownership can
 * hold a last-known value through a blip; an action cannot.
 *
 * - The LIVE session is exact and needs no frame to become true, so a
 *   renegotiation is visible the moment it happens.
 * - The STAMP covers the gap while a session is mid-reconnect and reports
 *   `null`: ownership genuinely is unknown then, and the last value this
 *   stream actually delivered under beats thrashing the slot over a blip.
 * - The CLIENT-WIDE value is the cold-start fallback only. Answering "unknown"
 *   before anything has negotiated would hand the rich slot back to the unary
 *   query on every mount - a redundant fetch per panel to close a window the
 *   handshake closes on its own. It is also exactly what this code read before
 *   any of this existed, so the fallback cannot regress a cold mount.
 */
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
  // Watcher health belongs to the session that reported it. Retiring the
  // generation is exactly what makes the old session's callbacks inert, so
  // nothing downstream can ever clear this value on its behalf - and the
  // replacement may negotiate a different minor, or reach a different host
  // incarnation, before its first frame lands. `markTerminal` covers the
  // terminal path; this covers replacement, which bypasses it.
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

  // Terminal teardown that keeps the map entry (and its error) alive for the
  // mounted consumers: the entry only leaves the map through the refCount
  // lifecycle, so a later fresh mount re-subscribes from scratch while the
  // current ones render the error instead of a forever-pending skeleton.
  const markTerminal = (event: GitSubscribeStatusEvent): void => {
    if (generation !== shared.sessionGeneration) return;
    sessionClosed = true;
    session.close();
    shared.lastEvent = event;
    // Terminal teardown DROPS watcher health, unlike a non-fatal error frame
    // which preserves it. The distinction is whether anything is still
    // arriving: a failing git compute keeps polling, so "refreshing on a
    // timer" stays true, but a fatal frame or a closed transport means no
    // frame will ever arrive again. Keeping the notice there would promise
    // periodic refreshes that have permanently stopped - most misleading in
    // the panel, where cached data keeps the view looking alive.
    shared.lastWatcherStatus = null;
    // Same cliff for the negotiated version, and it needs BOTH halves dropped.
    // A closed `StreamSession` keeps reporting the minor it last negotiated -
    // only `resetForReconnect` clears that, not `close()` - and the stamp is
    // just as stale. Left in place, this entry would go on claiming the stream
    // owns the rich slot while no stream remains to write it, so the unary
    // query stays disabled and the panel has no writer at all.
    //
    // Falling back to the client-wide value here is exactly right: closing the
    // session removes it from `ownedSessions` and reconciles the method's
    // version away, which is how this case used to resolve itself.
    shared.session = null;
    shared.negotiatedVersion = null;
    shared.terminated = true;
    settleSharedRefresh(shared, entryKey);
    notifyEntryChanged(entryKey);
    notifyConsumers(shared);
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed || generation !== shared.sessionGeneration) return;

    // The negotiated version is read AT DELIVERY TIME (never from a
    // render-stale closure): the handshake can settle after the subscribe,
    // and ownership of the rich slot must flip with the version, not with a
    // React render. It is read off the DELIVERING SESSION, so a sibling repo's
    // stream sitting at another minor cannot decide how this frame is parsed.
    const negotiated = session.getNegotiatedSchemaVersion();
    publishNegotiatedVersion(shared, negotiated, entryKey);
    const tier = frameTierOf(negotiated);
    const v13Frames = tier === "v13";
    const v12Frames = tier === "v13" || tier === "v12";
    const richFrames = v12Frames || tier === "rich";

    // Server wraps the event as `envelope.value` per the host's
    // SendServerFrame contract (see git-stream-resolvers.ts).
    //
    // Minors 2 and 3 share one handler but NOT one schema: parsing against
    // the negotiated minor is what keeps a v1.3-only field off a connection
    // that negotiated 1.2, independently of the host projecting correctly.
    if (v12Frames) {
      // STRICT at both minors: `watcher` is required at v1.3, and this session
      // is the one that agreed to send it, so a v1.3 frame without it is
      // malformed rather than skewed.
      //
      // This used to degrade a failed v1.3 parse to the v1.2 schema, because
      // the tier came from the client-wide version and could belong to a
      // sibling repo's stream - a genuine v1.2 frame would then fail the v1.3
      // parse and be dropped, freezing that repo's changes. Reading the
      // delivering session removes the skew, and with it the only benign reason
      // that fallback could fire. Keeping it would leave a lenient re-parse
      // standing in front of the contract for malformed frames alone, which is
      // exactly the bypass it was already narrowed once to avoid.
      const parsed = v13Frames
        ? gitSubscribeStatusEventSchemaV13.safeParse(envelope.value)
        : gitSubscribeStatusEventSchemaV12.safeParse(envelope.value);
      if (!parsed.success) {
        // Newly reachable now that the tolerant fallback is gone: this used to
        // degrade to the v1.2 schema and apply the frame anyway. A silent drop
        // freezes the panel on its last fingerprint until another frame
        // arrives, so say something - matching `TerminalStreamClient`, which
        // handles the same failure class the same way.
        //
        // Issue PATHS only. Never `parsed.error` or `envelope.value`: git
        // frames carry file paths and repository content.
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

    // Minor 0 / unknown: today's behavior verbatim - the frame writes ONLY
    // the v1.0 slot. It must never touch the rich slot: in this state the
    // unary+timer pair owns it, and a v1.1 parser default (`submodules: []`)
    // would clobber the unary-fed cache.
    writeIntoCache(queryClient, args, event, {
      parentSlotWrite: "always",
      invalidateDiffs: true,
    });
  });

  // Transport-terminal transitions (a fatal error frame, a closed client's
  // inert session, the no-progress UNAUTHORIZED give-up) never produce a
  // domain error frame - without this handler the subscription would sit in
  // a pending state forever (the stuck git-diff skeleton incident).
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
      // A recoverable drop never reaches `"closed"` - `resetForReconnect()`
      // parks the logical session here - so `markTerminal` is not on this
      // path. Without an explicit clear, a degraded value would survive the
      // whole backoff, or an indefinite outage, while NO frame can arrive to
      // contradict it: the panel keeps stating "Periodic refresh" as fact when
      // the client has no current evidence for anything.
      //
      // Deliberately not the same as the error-frame rule: a non-fatal git
      // error still arrives over a live stream, so the last watcher value is
      // still the host's most recent word. A dead stream is not.
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

/**
 * Shared by minors 2 and 3: both carry `freshNonce`, so the replacement
 * correlation is identical. The caller parses against its own minor's schema,
 * which is what keeps `watcher` off a v1.2 frame.
 */
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
    return "The Git changes stream closed unexpectedly.";
  }
  return `The Git changes stream failed (${reason.details.code}): ${reason.details.reason}`;
}

/**
 * Writes subscription events into the TanStack Query cache.
 * Authorization: CLAUDE.md "Optimistic setQueryData is reserved for response-equals-state cases".
 * This call falls under that carve-out: the host's `snapshot` / `updated` events ARE the
 * authoritative state of the working tree at the moment they are emitted. Writing them into
 * the cache is a fan-out of one wire event into the canonical query slot, not an optimistic
 * guess about a future response.
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

/**
 * Writes a RICH (v1.1) frame into BOTH cache slots - the stream owns the rich
 * slot in this state:
 * - the v1.0 slot gets the projected parent view (gitlink stripped, parent
 *   `fingerprint`), byte-compatible with what a minor-0 frame would carry;
 * - the rich slot gets the nested snapshot with `fingerprint` =
 *   `nestedFingerprint` (the unary v1.1 response identity), and its stream
 *   generation is bumped so any in-flight unary write is superseded.
 * Per-path diff invalidation covers the parent AND each submodule's
 * `changedPaths`, keyed on the submodule's own repo root (the diff slots for
 * submodule files already key on it).
 *
 * `opts` distinguishes live delivery from a consumer-join REPLAY. The v1.0
 * parent slot follows the same rule via `parentSlotWrite`: "always" on
 * delivery, "ifAbsent" on replay (a manual worktree-status refresh may have
 * written a newer unary response since the event was cached). For the rich
 * slot:
 * - `richSlotWrite: "always"` (delivery) writes the rich slot and bumps its
 *   stream generation (a new delivery supersedes in-flight unary fetches);
 * - `"ifAbsent"` (replay under stream ownership) REFILLS a GC-collected slot
 *   only - a present value may be NEWER unary data (manual refresh accepted
 *   after this event was cached) and must win; the refill records stream
 *   provenance without a generation bump (a replay is not a new delivery and
 *   must never supersede an in-flight unary request);
 * - `"never"` (replay after ownership flipped to fallback) writes only the
 *   v1.0 projection - stream data must never write the unary-owned rich slot.
 * A replay also never re-invalidates diffs (the frame already did on
 * delivery).
 */
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
 * Re-applies a shared session's cached last event to the query cache when a
 * NEW consumer joins: an unobserved slot may have been GC-collected since
 * delivery, and an unchanged repo emits no later frame to refill it. The
 * negotiated version is re-read at replay time - a rich event replays into
 * the rich slot only while the stream still owns it.
 *
 * OWNERSHIP, not provenance: this asks who writes the rich slot NOW, so it
 * reads the entry's current stamp rather than any tier recorded on the event
 * itself. The two questions look alike and must not share a field.
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

/**
 * ADR-0004 per-path diff invalidation across one or more repo roots (the
 * parent worktree and, on rich frames, each submodule root).
 */
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
