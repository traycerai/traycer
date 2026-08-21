import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { useEffect, useMemo, useReducer, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  IStreamSession,
  StreamCloseReason,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  workspaceSubscribeFileListServerFrameSchema,
  type WorkspaceSubscribeFileListClientFrame,
  type WorkspaceSubscribeFileListServerFrame,
} from "@traycer/protocol/host/workspace/subscribe";
import { workspaceQueryKeys } from "@/lib/query-keys/workspace-query-keys";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import {
  isWithinDirectory,
  projectWorkspaceFileList,
  selectWatchableDirectoryPaths,
  sortDirectoryPathsAncestorsFirst,
  WORKSPACE_FILE_LIST_ROOT_PATH,
  type WorkspaceFileListDirectoryListing,
  type WorkspaceFileListProjection,
} from "@/lib/workspace/workspace-file-list-tree";
import {
  useFileTreeExpandedPaths,
  useFileTreeStore,
} from "@/stores/file-tree/file-tree-store";

const STREAM_METHOD = "workspace.subscribeFileList";

/**
 * Per-directory listings for one workspace, as cached. A `listing` frame
 * replaces exactly its own directory's entry; every publish hands out a fresh
 * Map so the disabled `useQuery` mirror re-renders. A Map (not a plain object)
 * because directory tokens are user-controlled file names - `__proto__` is a
 * legal directory name.
 */
export type WorkspaceFileListDirectories = ReadonlyMap<
  string,
  WorkspaceFileListDirectoryListing
>;

export interface WorkspaceFileListSubscriptionResult extends WorkspaceFileListProjection {
  /** No listing has arrived yet and the stream has not failed. */
  readonly isPending: boolean;
  /** Terminal stream failure, already described for display. */
  readonly error: string | null;
}

interface ActiveSubscriptionArgs {
  readonly hostId: string;
  readonly workspacePath: string;
}

interface SharedSubscription {
  refCount: number;
  /** Re-render channel for state that never reaches the query cache. */
  consumers: Map<symbol, () => void>;
  /** Per-consumer requested coverage; the stream watches their union. */
  watchRequests: Map<symbol, ReadonlySet<string>>;
  /** Per-consumer prune sink, so each panel collapses its own expansion. */
  pruneListeners: Map<symbol, (directoryPaths: ReadonlyArray<string>) => void>;
  listings: Map<string, WorkspaceFileListDirectoryListing>;
  /** Coverage the host currently holds beyond the always-covered root. */
  appliedWatchPaths: Set<string>;
  session: IStreamSession | null;
  sessionGeneration: number;
  hasListing: boolean;
  error: string | null;
  closeCurrentSession: () => void;
  unsubscribeFromStream: () => void;
}

/**
 * Module-level ref-counted subscriptions keyed by the OWNING CLIENT INSTANCE
 * plus `(hostId, workspacePath)` - the same rule the git status subscription
 * uses. A rebuilt `WsStreamClient` (host swap, sign-in change, liveness
 * rebuild) must never be served an entry whose session belongs to a previous,
 * possibly closed client: every consumer's effect re-runs on the client
 * change, drains the old entry to refCount 0 (tearing its session down), and
 * opens a fresh entry against the new client.
 */
const subscriptions = new Map<string, SharedSubscription>();

function subscriptionKeyFor(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.workspacePath}`;
}

/** Test helper to reset module state. */
export function __resetWorkspaceFileListSubscriptionsForTesting(): void {
  for (const shared of subscriptions.values()) shared.unsubscribeFromStream();
  subscriptions.clear();
}

/**
 * Live single-level listings for one workspace, projected into the flat path
 * list the tree adapter consumes.
 *
 * Coverage follows the caller's expansion state (`file-tree-store`): expanding
 * a directory sends `watch`, collapsing sends `unwatch`, and on every
 * (re)connect the whole restored set goes up as ONE batched `watch` frame.
 * Host scope is explicit - the caller passes the host id its unary path
 * already resolves against; nothing here reads an ambient host.
 */
export function useWorkspaceFileListSubscription(args: {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly workspacePath: string | null;
  readonly enabled: boolean;
}): WorkspaceFileListSubscriptionResult {
  const queryClient = useQueryClient();
  const wsStreamClient = useWsStreamClient();
  const pruneExpandedPaths = useFileTreeStore((s) => s.pruneExpandedPaths);
  const expandedPaths = useFileTreeExpandedPaths(
    args.epicId,
    args.hostId,
    args.workspacePath,
  );
  // Events that do not write the query cache (terminal errors) still have to
  // re-render their consumers; a disabled query is not reliably notified by
  // invalidation, so they ride this channel instead.
  const [, forceRender] = useReducer((renderCount: number) => {
    return renderCount + 1;
  }, 0);
  const [consumerId] = useState(() => Symbol("workspace-file-list-consumer"));

  const { epicId, hostId, workspacePath, enabled } = args;
  const watchPaths = useMemo(
    () => selectWatchableDirectoryPaths(expandedPaths),
    [expandedPaths],
  );
  // Serialized coverage request: a stable dependency for the coverage effect
  // that survives the array identity churn of a store write.
  const watchKey = watchPaths.join("\n");
  const requestedWatchPaths = useMemo(
    () => (watchKey.length === 0 ? [] : watchKey.split("\n")),
    [watchKey],
  );

  useEffect(() => {
    if (
      !enabled ||
      hostId === null ||
      workspacePath === null ||
      wsStreamClient === null
    ) {
      return;
    }
    const activeArgs: ActiveSubscriptionArgs = { hostId, workspacePath };
    const key = subscriptionKeyFor(wsStreamClient, activeArgs);
    let shared = subscriptions.get(key);
    if (shared === undefined) {
      shared = createSharedSubscription(
        wsStreamClient,
        queryClient,
        activeArgs,
      );
      subscriptions.set(key, shared);
    }

    shared.refCount += 1;
    shared.consumers.set(consumerId, forceRender);
    shared.pruneListeners.set(consumerId, (directoryPaths) => {
      pruneExpandedPaths(epicId, hostId, workspacePath, directoryPaths);
    });
    // A joining consumer may find a GC-collected query slot (the listings
    // themselves live on the shared entry, and an idle workspace produces no
    // later frame to refill it), so republish on join.
    publishListings(shared, queryClient, activeArgs);

    return () => {
      shared.refCount -= 1;
      shared.consumers.delete(consumerId);
      shared.pruneListeners.delete(consumerId);
      shared.watchRequests.delete(consumerId);
      // No grace period (ADR-0003): tear down as soon as the last consumer goes.
      if (shared.refCount === 0) {
        shared.unsubscribeFromStream();
        subscriptions.delete(key);
        return;
      }
      syncCoverage(shared);
    };
  }, [
    consumerId,
    enabled,
    epicId,
    hostId,
    pruneExpandedPaths,
    queryClient,
    workspacePath,
    wsStreamClient,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      hostId === null ||
      workspacePath === null ||
      wsStreamClient === null
    ) {
      return;
    }
    // Looked up (never captured): the lifecycle effect above re-creates the
    // shared entry on a remount, and this effect must always address the live
    // one. Deliberately no cleanup - the lifecycle effect owns removal, so a
    // coverage change is a single overwrite instead of an unwatch/re-watch
    // round trip.
    const shared = subscriptions.get(
      subscriptionKeyFor(wsStreamClient, { hostId, workspacePath }),
    );
    if (shared === undefined) return;
    shared.watchRequests.set(consumerId, new Set(requestedWatchPaths));
    syncCoverage(shared);
    // `epicId` is not read here, but it IS a dependency: the lifecycle effect
    // above re-runs on an epic change and its cleanup drops this consumer's
    // watch request. `requestedWatchPaths` is memoized on the joined path key,
    // so two epics with the same expanded set keep one identity - without
    // `epicId` this effect would not re-run and the coverage would stay
    // dropped until the user toggled a directory.
  }, [
    consumerId,
    enabled,
    epicId,
    hostId,
    requestedWatchPaths,
    workspacePath,
    wsStreamClient,
  ]);

  // Reactive mirror of the shared entry's listings. Fetching stays disabled -
  // the subscription is the only writer.
  const { data: directories } = useQuery({
    ...queryOptions({
      queryKey: workspaceQueryKeys.fileList(hostId, workspacePath ?? ""),
      queryFn: (): Promise<WorkspaceFileListDirectories> =>
        Promise.resolve(new Map()),
      staleTime: Infinity,
    }),
    enabled: false,
  });

  const shared =
    wsStreamClient === null || hostId === null || workspacePath === null
      ? undefined
      : subscriptions.get(
          subscriptionKeyFor(wsStreamClient, { hostId, workspacePath }),
        );

  const projection = useMemo(
    () =>
      projectWorkspaceFileList(
        directories ?? new Map(),
        new Set([WORKSPACE_FILE_LIST_ROOT_PATH, ...requestedWatchPaths]),
      ),
    [directories, requestedWatchPaths],
  );

  const error = shared?.error ?? null;
  return {
    ...projection,
    isPending: shared?.hasListing !== true && error === null,
    error,
  };
}

function createSharedSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): SharedSubscription {
  const shared: SharedSubscription = {
    refCount: 0,
    consumers: new Map(),
    watchRequests: new Map(),
    pruneListeners: new Map(),
    listings: new Map(),
    appliedWatchPaths: new Set(),
    session: null,
    sessionGeneration: 0,
    hasListing: false,
    error: null,
    closeCurrentSession: () => undefined,
    unsubscribeFromStream: () => undefined,
  };
  shared.unsubscribeFromStream = () => {
    shared.sessionGeneration += 1;
    shared.session = null;
    shared.closeCurrentSession();
  };
  openStreamSession(shared, wsStreamClient, queryClient, args);
  return shared;
}

function openStreamSession(
  shared: SharedSubscription,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): void {
  // Retire the previous generation BEFORE closing it, so a synchronous close
  // callback cannot publish a terminal error over the fresh session.
  shared.sessionGeneration += 1;
  const generation = shared.sessionGeneration;
  shared.closeCurrentSession();
  const session = wsStreamClient.subscribe(STREAM_METHOD, {
    workspacePath: args.workspacePath,
  });
  let sessionClosed = false;
  shared.session = session;
  shared.closeCurrentSession = () => {
    sessionClosed = true;
    session.close();
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed || generation !== shared.sessionGeneration) return;
    const parsed =
      workspaceSubscribeFileListServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    handleServerFrame(shared, queryClient, args, parsed.data);
  });

  session.onStatusChange((status, reason) => {
    if (sessionClosed || generation !== shared.sessionGeneration) return;
    if (status === "open") {
      // A (re)subscribe covers the workspace root and nothing else, whatever
      // this stream covered before the drop. Forgetting the applied set makes
      // the next sync restore the WHOLE requested coverage in one batched
      // `watch` frame.
      shared.appliedWatchPaths = new Set();
      shared.error = null;
      syncCoverage(shared);
      notifyConsumers(shared);
      return;
    }
    if (status !== "closed") return;
    // Transport-terminal transitions (a fatal error frame, an inert session on
    // a closed client) never produce a domain frame; without this the panel
    // would sit pending forever.
    shared.session = null;
    shared.error = describeStreamClose(reason);
    notifyConsumers(shared);
  });
}

function handleServerFrame(
  shared: SharedSubscription,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
  frame: WorkspaceSubscribeFileListServerFrame,
): void {
  if (frame.kind === "pong") return;
  if (frame.kind === "listing") {
    // Idempotent per directory: the frame REPLACES this directory's state,
    // whether it answers a coverage-add or a filesystem change.
    shared.listings.set(frame.directoryPath, {
      entries: frame.entries,
      truncated: frame.truncated,
    });
    shared.hasListing = true;
    publishListings(shared, queryClient, args);
    return;
  }
  // `pruned`: the host stopped serving these directories. Their covered
  // descendants go with them (the contract drops them implicitly), and each
  // consumer collapses its own expansion so the coverage request cannot
  // immediately ask for the refused path again.
  for (const directoryPath of frame.directoryPaths) {
    for (const listedPath of [...shared.listings.keys()]) {
      if (isWithinDirectory(listedPath, directoryPath)) {
        shared.listings.delete(listedPath);
      }
    }
    for (const watchedPath of [...shared.appliedWatchPaths]) {
      if (isWithinDirectory(watchedPath, directoryPath)) {
        shared.appliedWatchPaths.delete(watchedPath);
      }
    }
  }
  for (const listener of shared.pruneListeners.values()) {
    listener(frame.directoryPaths);
  }
  publishListings(shared, queryClient, args);
}

/**
 * Brings the host's coverage in line with the union of its consumers'
 * requests. Frames are only sent while a session is live; otherwise the
 * applied set stays empty and the whole request is restored on the next
 * `"open"` transition.
 */
function syncCoverage(shared: SharedSubscription): void {
  const session = shared.session;
  if (session === null) return;
  const desired = new Set<string>();
  for (const request of shared.watchRequests.values()) {
    for (const directoryPath of request) desired.add(directoryPath);
  }
  const toWatch = [...desired].filter(
    (directoryPath) => !shared.appliedWatchPaths.has(directoryPath),
  );
  const toUnwatch = [...shared.appliedWatchPaths].filter(
    (directoryPath) => !desired.has(directoryPath),
  );
  if (toWatch.length > 0) {
    // Ancestors-first within the frame: the host applies a batch in order and
    // refuses a path whose parent is not yet covered. The requests themselves
    // are already ancestor-closed (`selectWatchableDirectoryPaths`), so only
    // the ordering is restored here - re-filtering a DELTA would wrongly drop
    // a child whose parent is merely already covered.
    sendClientFrame(session, {
      kind: "watch",
      directoryPaths: [...sortDirectoryPathsAncestorsFirst(toWatch)],
      hasBinaryPayload: false,
    });
  }
  if (toUnwatch.length > 0) {
    sendClientFrame(session, {
      kind: "unwatch",
      directoryPaths: toUnwatch,
      hasBinaryPayload: false,
    });
    // An unwatched directory is no longer live, so its rows must not linger:
    // re-expanding it re-watches and re-lists.
    for (const directoryPath of toUnwatch)
      shared.listings.delete(directoryPath);
  }
  shared.appliedWatchPaths = desired;
}

function sendClientFrame(
  session: IStreamSession,
  frame: WorkspaceSubscribeFileListClientFrame,
): void {
  session.sendClientFrame(frame, null);
}

/**
 * Publishes the shared entry's listings into the query cache.
 *
 * Authorization (CLAUDE.md "optimistic `setQueryData` is reserved for
 * response-equals-state cases"): a `listing` frame IS the authoritative
 * content of that directory at the moment it was emitted, so this is a fan-out
 * of a wire event into its canonical slot, not a guess about a future
 * response.
 */
function publishListings(
  shared: SharedSubscription,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): void {
  queryClient.setQueryData<WorkspaceFileListDirectories>(
    workspaceQueryKeys.fileList(args.hostId, args.workspacePath),
    new Map(shared.listings),
  );
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
    return "The workspace files stream closed unexpectedly.";
  }
  return `The workspace files stream failed (${reason.details.code}): ${reason.details.reason}`;
}
