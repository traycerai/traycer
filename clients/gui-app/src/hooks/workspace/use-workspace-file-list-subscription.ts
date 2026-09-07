import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
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

/** A Map (not a plain object) because directory tokens are user-controlled file names - `__proto__` is a legal directory name. */
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
  /** This entry's slot in `subscriptions`; the `entryListeners` channel key. */
  readonly key: string;
  refCount: number;
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

/** A rebuilt `WsStreamClient` (host swap, sign-in change, liveness rebuild) must never be served an entry whose session belongs to a previous, possibly closed client: every consumer's effect re-runs on the client change, drains the old entry to refCount 0 (tearing its session down), and opens a fresh entry against the new client. */
const subscriptions = new Map<string, SharedSubscription>();

function subscriptionKeyFor(
  client: IHostStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.workspacePath}`;
}

/**
 * Subscribe by key before the entry exists. React Compiler memoizes a render-time `subscriptions.get(key)` on inputs that do not change when the listing lands; `useSyncExternalStore` owns the value.
 */
const entryListeners = new Map<string, Set<() => void>>();

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

function notifyEntryChanged(key: string): void {
  const listeners = entryListeners.get(key);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener();
}

/** Test helper to reset module state. */
export function __resetWorkspaceFileListSubscriptionsForTesting(): void {
  for (const shared of subscriptions.values()) shared.unsubscribeFromStream();
  subscriptions.clear();
}

/**
 * Coverage follows expansion: expand watches, collapse unwatches, reconnect sends one batched `watch`. Host id is explicit; nothing here reads an ambient host.
 */
export function useWorkspaceFileListSubscription(args: {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly workspacePath: string | null;
  readonly enabled: boolean;
  /** Explicit host-bound transport; `undefined` uses the ambient sidebar client. */
  readonly streamClient:
    | IHostStreamClient<HostStreamRpcRegistry>
    | null
    | undefined;
  /** Null uses the persistent sidebar expansion store. */
  readonly expandedPathsOverride: ReadonlyArray<string> | null;
  readonly onPrunedOverride:
    | ((directoryPaths: ReadonlyArray<string>) => void)
    | null;
}): WorkspaceFileListSubscriptionResult {
  const queryClient = useQueryClient();
  const ambientStreamClient = useWsStreamClient();
  const wsStreamClient =
    args.streamClient === undefined ? ambientStreamClient : args.streamClient;
  const pruneExpandedPaths = useFileTreeStore((s) => s.pruneExpandedPaths);
  const storedExpandedPaths = useFileTreeExpandedPaths(
    args.epicId,
    args.hostId,
    args.workspacePath,
  );
  const expandedPaths = args.expandedPathsOverride ?? storedExpandedPaths;
  const [consumerId] = useState(() => Symbol("workspace-file-list-consumer"));

  const { epicId, hostId, workspacePath, enabled, onPrunedOverride } = args;
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
        key,
        wsStreamClient,
        queryClient,
        activeArgs,
      );
      subscriptions.set(key, shared);
    }

    shared.refCount += 1;
    shared.pruneListeners.set(consumerId, (directoryPaths) => {
      if (onPrunedOverride !== null) {
        onPrunedOverride(directoryPaths);
      } else {
        pruneExpandedPaths(epicId, hostId, workspacePath, directoryPaths);
      }
    });
    // A joining consumer may find a GC-collected query slot (the listings
    // themselves live on the shared entry, and an idle workspace produces no
    // later frame to refill it), so republish on join.
    publishListings(shared, queryClient, activeArgs);
    // The render that scheduled this effect read the entry-scoped snapshot
    // before the entry existed (or with a stale one); re-read it now.
    notifyEntryChanged(key);

    return () => {
      shared.refCount -= 1;
      shared.pruneListeners.delete(consumerId);
      shared.watchRequests.delete(consumerId);
      // No grace period (ADR-0003): tear down as soon as the last consumer goes.
      if (shared.refCount === 0) {
        shared.unsubscribeFromStream();
        subscriptions.delete(key);
        notifyEntryChanged(key);
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
    onPrunedOverride,
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
    // Deliberately no cleanup - the lifecycle effect owns removal, so a coverage change is a single overwrite instead of an unwatch/re-watch round trip.
    const shared = subscriptions.get(
      subscriptionKeyFor(wsStreamClient, { hostId, workspacePath }),
    );
    if (shared === undefined) return;
    shared.watchRequests.set(consumerId, new Set(requestedWatchPaths));
    syncCoverage(shared);
    // `requestedWatchPaths` is memoized on the joined path key, so two epics with the same expanded set keep one identity - without `epicId` this effect would not re-run and the coverage would stay dropped until the user toggled a directory.
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

  // Entry-scoped state is read through the store, never imperatively - see `entryListeners`.
  const key =
    wsStreamClient === null || hostId === null || workspacePath === null
      ? null
      : subscriptionKeyFor(wsStreamClient, { hostId, workspacePath });
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToEntry(key)(onStoreChange),
    [key],
  );
  const hasListing = useSyncExternalStore(
    subscribe,
    () => key !== null && subscriptions.get(key)?.hasListing === true,
    () => false,
  );
  const error = useSyncExternalStore(
    subscribe,
    () => (key === null ? null : (subscriptions.get(key)?.error ?? null)),
    () => null,
  );

  const projection = useMemo(
    () =>
      projectWorkspaceFileList(
        directories ?? new Map(),
        new Set([WORKSPACE_FILE_LIST_ROOT_PATH, ...requestedWatchPaths]),
      ),
    [directories, requestedWatchPaths],
  );

  return {
    ...projection,
    isPending: !hasListing && error === null,
    error,
  };
}

function createSharedSubscription(
  key: string,
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
): SharedSubscription {
  const shared: SharedSubscription = {
    key,
    refCount: 0,
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
      // A (re)subscribe covers the workspace root and nothing else, whatever this stream covered before the drop.
      shared.appliedWatchPaths = new Set();
      shared.error = null;
      syncCoverage(shared);
      notifyEntryChanged(shared.key);
      return;
    }
    if (status !== "closed") return;
    // Transport-terminal transitions (a fatal error frame, an inert session on
    // a closed client) never produce a domain frame; without this the panel
    // would sit pending forever.
    shared.session = null;
    shared.error = describeStreamClose(reason);
    notifyEntryChanged(shared.key);
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
    const isFirstListing = !shared.hasListing;
    shared.hasListing = true;
    publishListings(shared, queryClient, args);
    // Only the flip is render-relevant; every later listing reaches consumers
    // through the query cache.
    if (isFirstListing) notifyEntryChanged(shared.key);
    return;
  }
  // Their covered descendants go with them (the contract drops them implicitly), and each consumer collapses its own expansion so the coverage request cannot immediately ask for the refused path again.
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

/** Brings the host's coverage in line with the union of its consumers' requests. */
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
    // Ancestors-first within the frame: the host applies a batch in order and refuses a path whose parent is not yet covered.
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
 * A `listing` frame is that directory; write it into the query cache.
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
    return "The workspace files stream closed unexpectedly.";
  }
  return `The workspace files stream failed (${reason.details.code}): ${reason.details.reason}`;
}
