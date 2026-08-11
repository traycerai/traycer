import { useCallback, useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";

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
import { mentionQueryKeys } from "@/lib/query-keys";

/**
 * The section's cached catalog, and the two ways it gets fresher.
 *
 * The read is always `refresh: "none"` - cache-only, zero GitHub calls - so the
 * section paints stale-first the moment it opens. When the host answers
 * `stale: true` the hook follows with exactly ONE `refresh: "auto"` call, and
 * the refresh button sends `refresh: "manual"`.
 *
 * The three-way intent is load-bearing, not decoration. `auto` runs in the
 * host's interactive lane and is suppressed at the budget floor; `manual` is
 * the user asking, and is admitted where `auto` is not. Sending `manual` for
 * the automatic follow-up would escalate EVERY stale menu-open past the floors
 * the limiter exists to enforce - so the follow-up below must never be
 * "helpfully" upgraded.
 */

// The host's own staleness window is what decides whether a read is stale;
// this only bounds how often the cache-only read is re-issued while the menu
// is being opened and closed. A cache-only call is cheap but not free.
const CATALOG_STALE_TIME_MS = 60_000;

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
  /**
   * Whether a `stale: true` answer should be followed with the `"auto"` sweep.
   *
   * False for the root-step hydration read, which exists only to warm the row
   * store that root search reads. Hydration must stay strictly cache-only:
   * every `@` keypress at root would otherwise queue a GitHub sweep for two
   * sections the user has not opened.
   */
  readonly allowStaleFollowUp: boolean;
}

export interface GithubMentionCatalogResult {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  /**
   * The repos the host actually resolved from this scope's folders.
   *
   * Deliberately the HOST's answer rather than one derived from the rows: an
   * empty list means "these folders have no GitHub remote", which is a
   * different sentence from "repos exist, nothing matched" - and rows alone
   * cannot tell those apart. It also lets the Repository filter group render
   * against a cold cache, before any row has arrived.
   */
  readonly repositories: ReadonlyArray<GithubMentionRepository>;
  /** Null until the host has answered at all - "scope not yet known". */
  readonly scopeResolved: boolean;
  readonly freshnessAt: number | null;
  readonly sourceStatus: PrSourceStatus;
  readonly notice: PrSourceNotice | null;
  /** No cached rows have arrived yet - the `Loading…` row's condition. */
  readonly isLoading: boolean;
  /** Something is in flight behind rows that are already on screen. */
  readonly isChecking: boolean;
  /**
   * True when `rows`/`repositories` are TanStack's placeholder - the PREVIOUS
   * scope's answer, held while this scope's read lands.
   *
   * Rendering them is the documented intent ("rows stay on screen while a newer
   * read lands"). RECORDING them is not: the session store is keyed by the
   * current scope, so writing a placeholder into it would persist another
   * scope's rows past the window the placeholder covers. Render stale, do not
   * record stale.
   */
  readonly isPlaceholder: boolean;
  readonly refreshManually: () => Promise<void>;
}

const EMPTY_ROWS: ReadonlyArray<GithubMentionRow> = [];
const EMPTY_REPOSITORIES: ReadonlyArray<GithubMentionRepository> = [];

export function useGithubMentionCatalog(
  params: UseGithubMentionCatalogParams,
): GithubMentionCatalogResult {
  const { client, scope, section, enabled, allowStaleFollowUp } = params;
  const queryClient = useQueryClient();
  const readiness = useReactiveHostReadiness(client);

  const cacheOnlyRequest = useMemo<MentionGithubCatalogRequest>(
    () => ({
      epicId: scope.epicId,
      workspacePaths: [...scope.workspacePaths],
      section,
      refresh: "none",
    }),
    [scope.epicId, scope.workspacePaths, section],
  );

  const catalogQuery = useHostQuery<HostRpcRegistry, "mention.githubCatalog">({
    client,
    method: "mention.githubCatalog",
    params: cacheOnlyRequest,
    cacheKeyIdentity: undefined,
    options: {
      enabled: enabled && scope.workspacePaths.length > 0,
      staleTime: CATALOG_STALE_TIME_MS,
      // Rows stay on screen while a newer read lands, so re-opening the menu
      // never blanks a list the user was reading.
      placeholderData: keepPreviousData,
    },
  });

  const cacheKey = useMemo(
    () => mentionQueryKeys.githubCatalog(readiness.hostId, cacheOnlyRequest),
    [readiness.hostId, cacheOnlyRequest],
  );

  // Both refresh lanes fold their response back into the slot the menu reads,
  // rather than re-issuing the cache-only read to observe their own effect.
  const applyResponse = useCallback(
    (response: MentionGithubCatalogResponse) => {
      queryClient.setQueryData<MentionGithubCatalogResponse>(
        cacheKey,
        response,
      );
    },
    [cacheKey, queryClient],
  );

  const refreshMutation = useHostMutation<
    HostRpcRegistry,
    "mention.githubCatalog"
  >({
    client,
    method: "mention.githubCatalog",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: applyResponse,
      // No toast. A degraded GitHub source is reported IN the menu - banner,
      // ⓘ notice, freshness stamp - and a toast over an open picker would
      // cover the rows it is talking about.
    },
  });

  const { mutateAsync } = refreshMutation;

  // One automatic follow-up per (scope, section) per menu session. The ref is
  // what keeps a re-render, or the response arriving still `stale`, from
  // turning "fetch once because the cache is old" into a fetch loop.
  const autoFollowedRef = useRef<string | null>(null);
  const followKey = `${scope.epicId ?? ""}\x1f${[...scope.workspacePaths].toSorted().join("\x1f")}\x1f${section}`;
  useEffect(() => {
    if (!enabled || !allowStaleFollowUp) {
      autoFollowedRef.current = null;
      return;
    }
    const data = catalogQuery.data;
    if (data === undefined || !data.stale) return;
    if (autoFollowedRef.current === followKey) return;
    autoFollowedRef.current = followKey;
    void mutateAsync({
      epicId: scope.epicId,
      workspacePaths: [...scope.workspacePaths],
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
    enabled,
    followKey,
    mutateAsync,
    scope.epicId,
    scope.workspacePaths,
    section,
  ]);

  const refreshManually = useCallback(async (): Promise<void> => {
    try {
      await mutateAsync({
        epicId: scope.epicId,
        workspacePaths: [...scope.workspacePaths],
        section,
        refresh: "manual",
      });
    } catch {
      // Manual refresh never ends in an error state over real cached rows.
      // The response the user is owed - "we asked; here is why nothing
      // changed" - arrives as the notice, which the top bar already shows.
    }
  }, [mutateAsync, scope.epicId, scope.workspacePaths, section]);

  return {
    ...catalogFacts(catalogQuery.data),
    isPlaceholder: catalogQuery.isPlaceholderData,
    isLoading:
      enabled && catalogQuery.data === undefined && catalogQuery.isLoading,
    isChecking:
      enabled && (catalogQuery.isFetching || refreshMutation.isPending),
    refreshManually,
  };
}

/**
 * The response's facts, with the "not answered yet" case named once.
 *
 * `sourceStatus` defaults to `cached` rather than `ok`: before the host has
 * said anything, "these rows are cached" is the only claim that is true of an
 * empty list, and `ok` would assert a successful fetch that never happened.
 */
function catalogFacts(
  data: MentionGithubCatalogResponse | undefined,
): Omit<
  GithubMentionCatalogResult,
  "isLoading" | "isChecking" | "isPlaceholder" | "refreshManually"
> {
  if (data === undefined) {
    return {
      rows: EMPTY_ROWS,
      repositories: EMPTY_REPOSITORIES,
      scopeResolved: false,
      freshnessAt: null,
      sourceStatus: "cached",
      notice: null,
    };
  }
  return {
    rows: data.rows,
    repositories: data.repositories,
    scopeResolved: true,
    freshnessAt: data.freshnessAt,
    sourceStatus: data.sourceStatus,
    notice: data.notice,
  };
}
