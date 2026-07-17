import { useMemo, useEffect, useReducer, useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  gitSubscribeStatusEventSchema,
  gitSubscribeStatusEventSchemaV11,
  type GitListChangedFilesResponse,
  type GitListChangedFilesResponseV11,
  type GitSubscribeStatusEvent,
  type GitSubscribeStatusEventV11,
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
  GitSubscribeStatusEvent | GitSubscribeStatusEventV11;

export interface GitListChangedFilesSubscriptionResult {
  readonly data: GitListChangedFilesResponse | null;
  readonly error: GitSubscribeStatusEvent | null;
  readonly isPending: boolean;
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
  readonly pollStartedAtMs: number | null;
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
  consumers: Map<symbol, () => void>;
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

function subscriptionKeyFor(
  client: WsStreamClient<HostStreamRpcRegistry>,
  args: ActiveSubscriptionArgs,
): string {
  return `${client.instanceId}|${args.hostId}|${args.runningDir}|${args.ignoreWhitespace ? "1" : "0"}`;
}

/** Render-time lookup of the shared entry this hook instance is attached to. */
function activeSubscriptionFor(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
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
      replayLastEventIntoCache(
        wsStreamClient,
        queryClient,
        activeArgs,
        shared.lastEvent,
      );
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
    isPending: data === null && errorEvent === null,
    repoState: data?.repoState ?? null,
    repoMode: data?.repoMode ?? null,
    pollStartedAtMs,
  };
}

function createSharedSubscription(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
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

  // Terminal teardown that keeps the map entry (and its error) alive for the
  // mounted consumers: the entry only leaves the map through the refCount
  // lifecycle, so a later fresh mount re-subscribes from scratch while the
  // current ones render the error instead of a forever-pending skeleton.
  const markTerminal = (event: GitSubscribeStatusEvent): void => {
    sessionClosed = true;
    session.close();
    shared.lastEvent = event;
    for (const consumer of shared.consumers.values()) {
      consumer();
    }
  };

  session.onServerFrame((envelope) => {
    if (sessionClosed) return;

    // The negotiated version is read AT DELIVERY TIME (never from a
    // render-stale closure): the handshake can settle after the subscribe,
    // and ownership of the rich slot must flip with the version, not with a
    // React render.
    const negotiated = wsStreamClient.getMethodSchemaVersion(
      "git.subscribeStatus",
    );
    const richFrames =
      negotiated !== null && negotiated.major === 1 && negotiated.minor >= 1;

    // Server wraps the event as `envelope.value` per the host's
    // SendServerFrame contract (see git-stream-resolvers.ts).
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
      shared.lastEvent = event;
      for (const consumer of shared.consumers.values()) {
        consumer();
      }
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

    shared.lastEvent = event;

    for (const consumer of shared.consumers.values()) {
      consumer();
    }

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
    if (sessionClosed) return;
    if (status !== "closed") return;
    markTerminal({
      type: "error",
      message: describeStreamClose(reason),
      isFatal: true,
    });
  });

  return shared;
}

function describeStreamClose(reason: StreamCloseReason | null): string {
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
 */
function replayLastEventIntoCache(
  wsStreamClient: WsStreamClient<HostStreamRpcRegistry>,
  queryClient: QueryClient,
  args: ActiveSubscriptionArgs,
  event: GitSubscribeStatusStreamEvent,
): void {
  if (event.type === "error") {
    return;
  }
  if ("nestedFingerprint" in event) {
    const negotiated = wsStreamClient.getMethodSchemaVersion(
      "git.subscribeStatus",
    );
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
