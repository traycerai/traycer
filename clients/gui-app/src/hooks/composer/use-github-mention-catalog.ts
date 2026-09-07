import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hashKey,
  keepPreviousData,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GithubMentionRepository,
  GithubMentionRow,
  GithubMentionSection,
  MentionGithubCatalogRequest,
  MentionGithubCatalogResponse,
} from "@traycer/protocol/host/mention-schemas";
import type {
  PrSourceNotice,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";

import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { mentionQueryKeys } from "@/lib/query-keys";

/** Cache-only read (refresh none). Follow stale with one auto refresh; the button sends manual. Never upgrade auto to manual. */

// The host's own staleness window is what decides whether a read is stale;
// this only bounds how often the cache-only read is re-issued while the menu
// is being opened and closed. A cache-only call is cheap but not free.
const CATALOG_STALE_TIME_MS = 60_000;

// A long-lived entry keeps one copy, still keyed by (host, scope, section), so a scope that drifts re-keys instead of serving another scope's rows.
const CATALOG_GC_TIME_MS = 30 * 60_000;

export interface GithubMentionScope {
  /** Null in the landing composer, which the host authorizes by paths instead. */
  readonly epicId: string | null;
  readonly workspacePaths: ReadonlyArray<string>;
}

export interface UseGithubMentionCatalogParams {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly scope: GithubMentionScope;
  readonly section: GithubMentionSection;
  readonly enabled: boolean;
  /** Hydration must stay strictly cache-only: every `@` keypress at root would otherwise queue a GitHub sweep for two sections the user has not opened. */
  readonly allowStaleFollowUp: boolean;
  /** Picker-open lifetime of the one-per-session follow-up. Do not reset on enabled or allowStaleFollowUp. */
  readonly pickerActive: boolean;
}

export interface GithubMentionCatalogResult {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  /** Deliberately the HOST's answer rather than one derived from the rows: an empty list means "these folders have no GitHub remote", which is a different sentence from "repos exist, nothing matched" - and rows alone cannot tell those apart. */
  readonly repositories: ReadonlyArray<GithubMentionRepository>;
  /** Null until the host has answered at all - "scope not yet known". */
  readonly scopeResolved: boolean;
  readonly freshnessAt: number | null;
  /** This is the clock for "which section's resolution is newer": `freshnessAt` is the host's last successful GitHub reach, and a degraded sweep re-resolves `repositories` WITHOUT advancing it - compared on `freshnessAt`, a sibling's older repository set can outrank the resolution that already saw a repository leave. */
  readonly answeredAt: number | null;
  readonly sourceStatus: PrSourceStatus;
  readonly notice: PrSourceNotice | null;
  /** Not a degraded answer (`sourceStatus` reports those): a rejection carries no rows and no scope, so nothing downstream can tell "empty" from "never answered" without it. */
  readonly errored: boolean;
  /** No cached rows have arrived yet - the `Loading…` row's condition. */
  readonly isLoading: boolean;
  /** Something is in flight behind rows that are already on screen. */
  readonly isChecking: boolean;
  /** Placeholder rows are the previous scope. Render them; do not record them. */
  readonly isPlaceholder: boolean;
  readonly refreshManually: () => Promise<void>;
}

const EMPTY_ROWS: ReadonlyArray<GithubMentionRow> = [];
const EMPTY_PENDING_REFRESHES: ReadonlySet<string> = new Set();
const EMPTY_REPOSITORIES: ReadonlyArray<GithubMentionRepository> = [];

/** The cache slot a refresh was issued against, captured at mutate time. */
interface CatalogRefreshContext {
  readonly destination: QueryKey;
  /** The host the request was ISSUED against, which the destination key already encodes but does not expose - `onError` has to compare hosts, and digging one back out of a `QueryKey` would depend on that key's shape. */
  readonly hostId: string | null;
}

export function useGithubMentionCatalog(
  params: UseGithubMentionCatalogParams,
): GithubMentionCatalogResult {
  const { client, scope, section, enabled, allowStaleFollowUp, pickerActive } =
    params;
  const queryClient = useQueryClient();
  const readiness = useReactiveHostReadiness(client);

  // A mutation REPLACED by a newer `mutate()` keeps the options it was built with - only the observer's current pending mutation is re-optioned on render - so a closure reading `readiness.hostId` inside a superseded mutation's callback holds whichever host was bound when it was replaced, not the one bound when it settles.
  const boundHostIdRef = useRef(readiness.hostId);
  useEffect(() => {
    boundHostIdRef.current = readiness.hostId;
  }, [readiness.hostId]);

  // ONE canonical ordering for every request this hook sends.
  const canonicalWorkspacePaths = useMemo(
    () => [...scope.workspacePaths].toSorted(),
    [scope.workspacePaths],
  );

  const cacheOnlyRequest = useMemo<MentionGithubCatalogRequest>(
    () => ({
      epicId: scope.epicId,
      workspacePaths: [...canonicalWorkspacePaths],
      section,
      refresh: "none",
    }),
    [scope.epicId, canonicalWorkspacePaths, section],
  );

  const catalogQuery = useHostQuery<HostRpcRegistry, "mention.githubCatalog">({
    client,
    method: "mention.githubCatalog",
    params: cacheOnlyRequest,
    cacheKeyIdentity: undefined,
    options: {
      enabled: enabled && scope.workspacePaths.length > 0,
      staleTime: CATALOG_STALE_TIME_MS,
      gcTime: CATALOG_GC_TIME_MS,
      // Rows stay on screen while a newer read lands, so re-opening the menu
      // never blanks a list the user was reading.
      placeholderData: keepPreviousData,
    },
  });

  const cacheKey = useMemo(
    () => mentionQueryKeys.githubCatalog(readiness.hostId, cacheOnlyRequest),
    [readiness.hostId, cacheOnlyRequest],
  );

  // Capture cacheKey in onMutate; a render-time key would write into the host bound when the response lands.
  const applyResponse = useCallback(
    (response: MentionGithubCatalogResponse, destination: QueryKey) => {
      queryClient.setQueryData<MentionGithubCatalogResponse>(
        destination,
        response,
      );
    },
    [queryClient],
  );

  // Track in-flight destinations as a set, not isPending or the latest key. Scope changes do not cancel requests.
  const [pendingRefreshKeys, setPendingRefreshKeys] = useState<
    ReadonlySet<string>
  >(EMPTY_PENDING_REFRESHES);

  const refreshMutation = useHostMutation<
    HostRpcRegistry,
    "mention.githubCatalog",
    CatalogRefreshContext
  >({
    client,
    method: "mention.githubCatalog",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => {
        const issued = hashKey(cacheKey);
        setPendingRefreshKeys((current) => {
          if (current.has(issued)) return current;
          const next = new Set(current);
          next.add(issued);
          return next;
        });
        return { destination: cacheKey, hostId: readiness.hostId };
      },
      onSuccess: (response, _variables, context) => {
        applyResponse(response, context.destination);
      },
      // No toast on a degraded response. Manual-lane rejections toast using boundHostIdRef, not the render-time host.
      onError: (error, variables, context) => {
        if (variables.refresh !== "manual") return;
        if (
          context !== undefined &&
          context.hostId !== boundHostIdRef.current
        ) {
          return;
        }
        toastFromHostError(error, "Could not refresh from GitHub");
      },
      // Clear only this mutation's destination from context, not the current render's cacheKey.
      onSettled: (_data, _error, _variables, context) => {
        if (context === undefined) return;
        const settled = hashKey(context.destination);
        setPendingRefreshKeys((current) => {
          if (!current.has(settled)) return current;
          const next = new Set(current);
          next.delete(settled);
          return next;
        });
      },
    },
  });

  const { mutateAsync } = refreshMutation;

  // One automatic follow-up per (host, scope, section) per menu session. Remember every followed key, not only the latest.
  const autoFollowedRef = useRef<Set<string>>(new Set());
  const followKey = `${readiness.hostId ?? ""}\x1f${scope.epicId ?? ""}\x1f${canonicalWorkspacePaths.join("\x1f")}\x1f${section}`;
  useEffect(() => {
    if (!pickerActive) {
      autoFollowedRef.current.clear();
      return;
    }
    if (!enabled || !allowStaleFollowUp) return;
    // The mark is the session's ONE follow-up for this key, so spending it on a request that never reached the host left the scope unrefreshed for the rest of the picker session once the context came back.
    if (!readiness.isReady) return;
    // Following its `stale` flag would spend a GitHub request - and rate-limit budget - deciding for a scope this answer was never about, before that scope has said a word.
    if (catalogQuery.isPlaceholderData) return;
    const data = catalogQuery.data;
    if (data === undefined || !data.stale) return;
    if (autoFollowedRef.current.has(followKey)) return;
    autoFollowedRef.current.add(followKey);
    void mutateAsync({
      epicId: scope.epicId,
      workspacePaths: [...canonicalWorkspacePaths],
      section,
      // NOT "manual". See the note at the top of this file.
      refresh: "auto",
    }).catch(() => {
      // A failed sweep degrades the SECTION, never the app: the cached rows
      // stay on screen and the host reports why through `notice`.
    });
  }, [
    allowStaleFollowUp,
    catalogQuery.data,
    catalogQuery.isPlaceholderData,
    enabled,
    followKey,
    mutateAsync,
    canonicalWorkspacePaths,
    pickerActive,
    readiness.isReady,
    scope.epicId,
    section,
  ]);

  const refreshManually = useCallback(async (): Promise<void> => {
    // A manual sweep pays the session's one follow-up for this key.
    autoFollowedRef.current.add(followKey);
    try {
      await mutateAsync({
        epicId: scope.epicId,
        workspacePaths: [...canonicalWorkspacePaths],
        section,
        refresh: "manual",
      });
    } catch {
      // Reported by the mutation's `onError`, which receives the rejection
      // already typed as `HostRpcError`. Swallowed here so the click handler
      // does not also reject at its call site.
    }
  }, [canonicalWorkspacePaths, followKey, mutateAsync, scope.epicId, section]);

  // Placeholder data is the previous scope. Treat it as unanswered so a mention cannot commit leftover rows.
  const answered = catalogQuery.isPlaceholderData
    ? undefined
    : catalogQuery.data;

  return {
    ...catalogFacts(
      answered,
      // A placeholder's `dataUpdatedAt` stamps the PREVIOUS scope's answer,
      // so it is withheld with the data - the null pair is what keeps every
      // derived fact describing one scope.
      answered === undefined ? null : catalogQuery.dataUpdatedAt,
    ),
    isPlaceholder: catalogQuery.isPlaceholderData,
    // `enabled` gates this like the two flags below: a disabled observer can still HOLD an error from when it was live, and a section that is not being asked must not report one.
    errored: enabled && catalogQuery.isError,
    isLoading: enabled && answered === undefined && catalogQuery.isFetching,
    // The set alone decides the refresh half.
    isChecking:
      enabled &&
      (catalogQuery.isFetching || pendingRefreshKeys.has(hashKey(cacheKey))),
    refreshManually,
  };
}

/** `sourceStatus` defaults to `cached` rather than `ok`: before the host has said anything, "these rows are cached" is the only claim that is true of an empty list, and `ok` would assert a successful fetch that never happened. */
function catalogFacts(
  data: MentionGithubCatalogResponse | undefined,
  answeredAt: number | null,
): Omit<
  GithubMentionCatalogResult,
  "errored" | "isLoading" | "isChecking" | "isPlaceholder" | "refreshManually"
> {
  if (data === undefined) {
    return {
      rows: EMPTY_ROWS,
      repositories: EMPTY_REPOSITORIES,
      scopeResolved: false,
      freshnessAt: null,
      answeredAt: null,
      sourceStatus: "cached",
      notice: null,
    };
  }
  return {
    rows: data.rows,
    repositories: data.repositories,
    scopeResolved: true,
    freshnessAt: data.freshnessAt,
    answeredAt,
    sourceStatus: data.sourceStatus,
    notice: data.notice,
  };
}
