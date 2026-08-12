import { useCallback, useEffect, useMemo, useRef } from "react";
import {
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
  /**
   * Whether the picker is open at all - the lifetime of the one-per-session
   * follow-up guard below, and the ONLY thing that resets it.
   *
   * Neither `enabled` nor `allowStaleFollowUp` can play that role: both flip
   * while a single menu session walks between root and a section (root turns
   * the follow-up off, opening the OTHER section disables this read entirely),
   * and clearing the guard on either edge turned "one sweep per session" into
   * one sweep per re-entry - so a user stepping in and out of a section whose
   * answer is still `stale: true` enqueues a GitHub sweep every time.
   */
  readonly pickerActive: boolean;
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

/** The cache slot a refresh was issued against, captured at mutate time. */
interface CatalogRefreshContext {
  readonly destination: QueryKey;
}

export function useGithubMentionCatalog(
  params: UseGithubMentionCatalogParams,
): GithubMentionCatalogResult {
  const { client, scope, section, enabled, allowStaleFollowUp, pickerActive } =
    params;
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
  //
  // The destination key is captured in `onMutate` and read back in
  // `onSuccess`. TanStack hands a pending mutation the LATEST render's
  // callbacks, so a `cacheKey` closed over at render time is the key of
  // whatever host is bound when the response lands - not the one the request
  // was issued against. Capturing it at mutate time is the repo's standing
  // rule for host-swap races, and here it is what stops one host's catalog
  // being written into another's slot.
  const applyResponse = useCallback(
    (response: MentionGithubCatalogResponse, destination: QueryKey) => {
      queryClient.setQueryData<MentionGithubCatalogResponse>(
        destination,
        response,
      );
    },
    [queryClient],
  );

  const refreshMutation = useHostMutation<
    HostRpcRegistry,
    "mention.githubCatalog",
    CatalogRefreshContext
  >({
    client,
    method: "mention.githubCatalog",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ destination: cacheKey }),
      onSuccess: (response, _variables, context) => {
        applyResponse(response, context.destination);
      },
      // No toast on a DEGRADED response. That is reported IN the menu -
      // banner, ⓘ notice, freshness stamp - and a toast over an open picker
      // would cover the rows it is talking about.
      //
      // A REJECTION is the other case entirely: it carries no response, so
      // none of that chrome can move and the spinner simply stops, leaving a
      // refresh that never reached the host indistinguishable from one that
      // found nothing new. Only the MANUAL lane reports it - the user asked
      // for that one - while the automatic follow-up stays silent rather than
      // nagging about a background sweep nobody requested.
      onError: (error, variables) => {
        if (variables.refresh !== "manual") return;
        toastFromHostError(error, "Could not refresh from GitHub");
      },
    },
  });

  const { mutateAsync } = refreshMutation;

  // One automatic follow-up per (host, scope, section) per menu session. The
  // ref is what keeps a re-render, or the response arriving still `stale`,
  // from turning "fetch once because the cache is old" into a fetch loop.
  //
  // It is CLEARED on exactly one edge - the picker closing - and the host,
  // scope and section live in the stored value instead, so a change to any of
  // them fails the comparison below without anything having to notice the
  // transition. See `pickerActive` for why the two narrower flags cannot own
  // this lifetime.
  //
  // The host is in the key for the same reason it is in `cacheKey` above: it
  // changes under an app-wide composer, and two hosts can advertise the same
  // epic and the same workspace paths. Keyed without it, the second host's
  // `stale: true` catalog reads as a sweep that already ran, and that host
  // never gets the one refresh a session owes it.
  const autoFollowedRef = useRef<string | null>(null);
  const followKey = `${readiness.hostId ?? ""}\x1f${scope.epicId ?? ""}\x1f${[...scope.workspacePaths].toSorted().join("\x1f")}\x1f${section}`;
  useEffect(() => {
    if (!pickerActive) {
      autoFollowedRef.current = null;
      return;
    }
    if (!enabled || !allowStaleFollowUp) return;
    // `keepPreviousData` hands over the PREVIOUS scope's response while the
    // new scope's cache-only read is in flight. Following its `stale` flag
    // would spend a GitHub request - and rate-limit budget - deciding for a
    // scope this answer was never about, before that scope has said a word.
    if (catalogQuery.isPlaceholderData) return;
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
    catalogQuery.isPlaceholderData,
    enabled,
    followKey,
    mutateAsync,
    pickerActive,
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
      // Reported by the mutation's `onError`, which receives the rejection
      // already typed as `HostRpcError`. Swallowed here so the click handler
      // does not also reject at its call site.
    }
  }, [mutateAsync, scope.epicId, scope.workspacePaths, section]);

  return {
    // A placeholder response belongs to the PREVIOUS scope, and its rows are
    // selectable: left exposed, a user can commit a mention naming a pull
    // request from the host, epic or roots they just left. Reported as the
    // unanswered case instead - which is what this scope has actually said so
    // far - so every derived fact (`scopeResolved`, the repositories, the
    // notice) describes one scope rather than two.
    ...catalogFacts(
      catalogQuery.isPlaceholderData ? undefined : catalogQuery.data,
    ),
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
