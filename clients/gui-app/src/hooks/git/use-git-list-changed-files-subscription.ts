import { useMemo, useCallback, useEffect, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  gitSubscribeStatusEventSchema,
  type GitListChangedFilesResponse,
  type GitSubscribeStatusEvent,
  type RepoMode,
  type RepoState,
} from "@traycer/protocol/host/git-schemas";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";

export interface GitListChangedFilesSubscriptionResult {
  readonly data: GitListChangedFilesResponse | null;
  readonly error: GitSubscribeStatusEvent | null;
  readonly isPending: boolean;
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
  readonly pollStartedAtMs: number | null;
}

type SubscriptionKey = `${string}|${string}|${string}`;

interface ActiveSubscriptionArgs {
  readonly hostId: string;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}

interface SharedSubscription {
  refCount: number;
  unsubscribeFromStream: () => void;
  lastEvent: GitSubscribeStatusEvent | null;
  consumers: Map<symbol, (event: GitSubscribeStatusEvent) => void>;
}

// Module-level ref-counted subscriptions.
const subscriptions = new Map<SubscriptionKey, SharedSubscription>();

// Test helper to reset module state.
export function __resetSubscriptionsForTesting(): void {
  // Close and clear all subscriptions.
  for (const sub of subscriptions.values()) {
    sub.unsubscribeFromStream();
  }
  subscriptions.clear();
}

export function useGitListChangedFilesSubscription(args: {
  readonly hostId: string | null;
  readonly runningDir: string | null;
  readonly ignoreWhitespace: boolean;
  readonly enabled: boolean;
}): GitListChangedFilesSubscriptionResult {
  const queryClient = useQueryClient();
  const wsStreamClient = useWsStreamClient();

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

  const makeKey = useCallback((): SubscriptionKey => {
    return `${stableArgs.hostId}|${stableArgs.runningDir}|${stableArgs.ignoreWhitespace ? "1" : "0"}`;
  }, [stableArgs]);

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

    const key = makeKey();
    const activeArgs: ActiveSubscriptionArgs = {
      hostId: stableArgs.hostId,
      runningDir: stableArgs.runningDir,
      ignoreWhitespace: stableArgs.ignoreWhitespace,
    };
    let shared = subscriptions.get(key);

    if (shared === undefined) {
      shared = createSharedSubscription(
        wsStreamClient,
        queryClient,
        activeArgs,
        () => {
          subscriptions.delete(key);
        },
      );
      subscriptions.set(key, shared);
    }

    // Increment ref count and register local consumer.
    shared.refCount += 1;

    const localUpdate = () => {
      // Trigger a re-render by invalidating the query.
      // The hook's useQuery below will pick up the latest cache state.
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.listChangedFiles(
          stableArgs.hostId ?? "",
          stableArgs.runningDir ?? "",
          stableArgs.ignoreWhitespace,
        ),
      });
    };

    shared.consumers.set(consumerId, localUpdate);

    // If we have a cached event, deliver it immediately.
    if (shared.lastEvent !== null) {
      localUpdate();
    }

    // Cleanup on unmount.
    return () => {
      shared.refCount -= 1;
      shared.consumers.delete(consumerId);

      // ADR-0003: no grace period - tear down immediately when ref count reaches 0.
      if (shared.refCount === 0) {
        shared.unsubscribeFromStream();
        subscriptions.delete(key);
      }
    };
  }, [stableArgs, makeKey, queryClient, wsStreamClient, consumerId]);

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

  const subscription = subscriptions.get(
    `${stableArgs.hostId}|${stableArgs.runningDir}|${stableArgs.ignoreWhitespace ? "1" : "0"}`,
  );

  const lastEvent = subscription?.lastEvent ?? null;
  const errorEvent = lastEvent?.type === "error" ? lastEvent : null;
  const pollStartedAtMs =
    lastEvent !== null && lastEvent.type !== "error"
      ? lastEvent.pollStartedAtMs
      : null;

  const data = queryData ?? null;

  return {
    data,
    error: errorEvent,
    isPending: data === null,
    repoState: data?.repoState ?? null,
    repoMode: data?.repoMode ?? null,
    pollStartedAtMs,
  };
}

function createSharedSubscription(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
  removeSubscription: () => void,
): SharedSubscription {
  const session = wsStreamClient.subscribe("git.subscribeStatus", {
    hostId: args.hostId,
    runningDir: args.runningDir,
    ignoreWhitespace: args.ignoreWhitespace,
  });

  let sessionClosed = false;
  const shared: SharedSubscription = {
    refCount: 0,
    unsubscribeFromStream: () => {
      sessionClosed = true;
      session.close();
    },
    lastEvent: null,
    consumers: new Map(),
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed) return;

    // Server wraps the event as `envelope.value` per the host's
    // SendServerFrame contract (see git-stream-resolvers.ts).
    const parseResult = gitSubscribeStatusEventSchema.safeParse(envelope.value);
    if (!parseResult.success) {
      return;
    }
    const event = parseResult.data;

    shared.lastEvent = event;

    for (const consumer of shared.consumers.values()) {
      consumer(event);
    }

    writeIntoCache(queryClient, args, event);

    if (event.type === "error" && event.isFatal) {
      shared.unsubscribeFromStream();
      shared.consumers.clear();
      removeSubscription();
    }
  });

  return shared;
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
): void {
  if (event.type === "error") {
    return;
  }

  if (args.runningDir === null) {
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

  if (event.type === "updated" && event.changedPaths.length > 0) {
    // ADR-0004: Per-path invalidation for changed files.
    const hostId = args.hostId;
    const runningDir = args.runningDir;
    const changedSet = new Set<string>(event.changedPaths);
    void queryClient.invalidateQueries({
      predicate: (query) =>
        gitQueryKeys.matchFileDiff(
          query.queryKey,
          hostId,
          runningDir,
          changedSet,
        ),
    });
  }
}
