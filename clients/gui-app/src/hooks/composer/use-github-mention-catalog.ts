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

// Session warmth lives in the QUERY ENTRY, not in a parallel store. The menu's
// observers unmount when the picker closes, and TanStack's default 5-minute
// `gcTime` would evict the rows root search ranks before the next open - the
// gap a session-lived row store used to paper over, at the price of being a
// second copy of server data that outlived the resolution that wrote it. A
// long-lived entry keeps one copy, still keyed by (host, scope, section), so a
// scope that drifts re-keys instead of serving another scope's rows.
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
  /**
   * When THIS scope's answer arrived at the client (TanStack's
   * `dataUpdatedAt`), or null while unanswered. This is the clock for "which
   * section's resolution is newer": `freshnessAt` is the host's last
   * successful GitHub reach, and a degraded sweep re-resolves `repositories`
   * WITHOUT advancing it - compared on `freshnessAt`, a sibling's older
   * repository set can outrank the resolution that already saw a repository
   * leave.
   */
  readonly answeredAt: number | null;
  readonly sourceStatus: PrSourceStatus;
  readonly notice: PrSourceNotice | null;
  /**
   * The cache-only read itself FAILED - retries exhausted, no response at all.
   * Not a degraded answer (`sourceStatus` reports those): a rejection carries
   * no rows and no scope, so nothing downstream can tell "empty" from "never
   * answered" without it. The zero-match dismissal reads this the way it reads
   * the workspace and epic errors - a failed source proves nothing empty.
   */
  readonly errored: boolean;
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
const EMPTY_PENDING_REFRESHES: ReadonlySet<string> = new Set();
const EMPTY_REPOSITORIES: ReadonlyArray<GithubMentionRepository> = [];

/** The cache slot a refresh was issued against, captured at mutate time. */
interface CatalogRefreshContext {
  readonly destination: QueryKey;
  /**
   * The host the request was ISSUED against, which the destination key already
   * encodes but does not expose - `onError` has to compare hosts, and digging
   * one back out of a `QueryKey` would depend on that key's shape.
   */
  readonly hostId: string | null;
}

export function useGithubMentionCatalog(
  params: UseGithubMentionCatalogParams,
): GithubMentionCatalogResult {
  const { client, scope, section, enabled, allowStaleFollowUp, pickerActive } =
    params;
  const queryClient = useQueryClient();
  const readiness = useReactiveHostReadiness(client);

  // The bound host as of NOW, for callbacks whose closure can outlive its
  // render. A mutation REPLACED by a newer `mutate()` keeps the options it was
  // built with - only the observer's current pending mutation is re-optioned
  // on render - so a closure reading `readiness.hostId` inside a superseded
  // mutation's callback holds whichever host was bound when it was replaced,
  // not the one bound when it settles.
  const boundHostIdRef = useRef(readiness.hostId);
  useEffect(() => {
    boundHostIdRef.current = readiness.hostId;
  }, [readiness.hostId]);

  // ONE canonical ordering for every request this hook sends. The scope is
  // order-independent everywhere else (`githubMentionScopeKey` and the
  // follow-up key both sort), but the WIRE request is what the TanStack query
  // key and the pending-refresh keys hash - unsorted, two orderings of the
  // same folder set forked one logical scope into two cache slots, a refresh
  // issued under the old ordering wrote its response to a slot the menu no
  // longer reads, and the current slot neither showed the response nor
  // reported the refresh as pending.
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

  // Which slots have an in-flight refresh, so `isChecking` can tell "this
  // scope is being refreshed" from "some scope is".
  //
  // One mutation observer outlives every scope this hook is rendered for - the
  // section stays mounted while the roots, the epic and the bound host change
  // underneath it - so `isPending` alone says only that SOMETHING is in
  // flight. Left unscoped, changing folders mid-refresh made the new scope
  // claim it was checking and disabled its own Refresh button until a request
  // it never issued came back.
  //
  // A SET of destinations, not the latest one: scope changes do not cancel
  // requests, so refresh A, a switch to B that starts its own, and a return
  // to A leaves BOTH in flight - and a single latest-key slot forgot A's, so
  // A's button re-enabled mid-refresh and could spend a duplicate GitHub
  // request racing the original. Same shape as the follow-up guard above.
  //
  // State rather than a ref: this is read during render to derive `isChecking`,
  // and a ref read there is both a lint error here and genuinely wrong under
  // concurrent rendering. The two writes sit on the same edges `isPending`
  // already flips on, so they cost no render that was not happening anyway.
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
      // The host guard is the same rule as `destination` above, applied to the
      // other outcome: an app-wide composer can rebind while this request is in
      // flight, and the toast would then blame the host the user is now looking
      // at for a refresh the one they LEFT rejected. The currently bound host
      // comes from `boundHostIdRef`, NOT from `readiness.hostId` closed over
      // at render: a superseded mutation's options are frozen at the render
      // where a newer `mutate()` replaced it, so its closure would hold that
      // intermediate host and suppress a toast the now-bound host should show
      // after an away-and-back walk.
      //
      // A missing context still toasts. `onMutate` is a synchronous object
      // literal that cannot throw, so this is unreachable in practice, and
      // preserving the old behaviour there is better than minting a silent
      // path that drops a real rejection.
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
      // Removes only the settling refresh's own destination.
      //
      // Two can be open at once: a scope change does not cancel the request
      // the previous scope issued, and the new scope can start its own while
      // that is still running. Clearing unconditionally meant whichever
      // finished FIRST cleared the flag - so a departed host's refresh landing
      // early took the spinner off the current scope's still-running one and
      // re-enabled its button mid-refresh.
      //
      // The settling mutation's own destination comes from its context, not
      // from this render: `cacheKey` here belongs to whatever scope is bound
      // now, which is exactly the value that cannot identify the request that
      // just finished.
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

  // One automatic follow-up per (host, scope, section) per menu session. The
  // ref is what keeps a re-render, or the response arriving still `stale`,
  // from turning "fetch once because the cache is old" into a fetch loop.
  // EITHER lane's sweep pays that debt: the effect marks the key before it
  // issues, and `refreshManually` marks it too, because a manual sweep is the
  // very request the follow-up would otherwise spend (see the note there).
  //
  // It is CLEARED on exactly one edge - the picker closing - and the host,
  // scope and section live in the stored KEYS instead, so a change to any of
  // them misses the set below without anything having to notice the
  // transition. A set of every followed key, not the latest key alone: one
  // menu session can walk scope A → B → back to A (folders detached and
  // re-attached, an app-wide host swapped and swapped back), and A's
  // follow-up was already paid on the way out - remembering only the most
  // recent key re-spent it on every return trip. See `pickerActive` for why
  // the two narrower flags cannot own this lifetime.
  //
  // The host is in the key for the same reason it is in `cacheKey` above: it
  // changes under an app-wide composer, and two hosts can advertise the same
  // epic and the same workspace paths. Keyed without it, the second host's
  // `stale: true` catalog reads as a sweep that already ran, and that host
  // never gets the one refresh a session owes it.
  const autoFollowedRef = useRef<Set<string>>(new Set());
  const followKey = `${readiness.hostId ?? ""}\x1f${scope.epicId ?? ""}\x1f${canonicalWorkspacePaths.join("\x1f")}\x1f${section}`;
  useEffect(() => {
    if (!pickerActive) {
      autoFollowedRef.current.clear();
      return;
    }
    if (!enabled || !allowStaleFollowUp) return;
    // READY, not merely bound: the query cache can still serve this scope's
    // `stale: true` answer while the host has no authenticated request
    // context, and a mutation issued then dies at preflight - after the mark
    // below was already made. The mark is the session's ONE follow-up for
    // this key, so spending it on a request that never reached the host left
    // the scope unrefreshed for the rest of the picker session once the
    // context came back. Deferring both (the mark and the send) costs
    // nothing: this effect re-runs when readiness flips.
    if (!readiness.isReady) return;
    // `keepPreviousData` hands over the PREVIOUS scope's response while the
    // new scope's cache-only read is in flight. Following its `stale` flag
    // would spend a GitHub request - and rate-limit budget - deciding for a
    // scope this answer was never about, before that scope has said a word.
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
    // A manual sweep pays the session's one follow-up for this key. The ref
    // above only knows about sweeps the AUTO lane issued, so a manual response
    // arriving still `stale` - GitHub rate-limited, a partial sweep - landed in
    // the slot the follow-up effect watches with the ref unset, and the effect
    // immediately spent a second, automatic request re-asking the question the
    // user just watched be answered. Marked at ISSUE time, not on success: a
    // manual attempt that fails was already reported by `onError`, and a
    // silent automatic retry right behind a refresh that just failed is budget
    // spent on the same outcome.
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

  // What THIS scope has actually said, which is not `catalogQuery.data`: a
  // placeholder response belongs to the PREVIOUS scope, and its rows are
  // selectable, so left exposed a user can commit a mention naming a pull
  // request from the host, epic or roots they just left. Reported as the
  // unanswered case instead, so every derived fact - `scopeResolved`, the
  // repositories, the notice, and the loading row - describes one scope rather
  // than two.
  //
  // Read by EVERYTHING below, deliberately. Deriving one fact from the raw
  // query while the rest read this is how the section came to render a settled
  // empty list for a scope that had not answered: `keepPreviousData` leaves
  // `data` defined and the query `success`, so a loading flag taken off the
  // query is false while the rows taken off this are empty.
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
    // `enabled` gates this like the two flags below: a disabled observer can
    // still HOLD an error from when it was live, and a section that is not
    // being asked must not report one. Retries keep `isFetching` true, so the
    // window where this is the only sign of the failure opens exactly when
    // the query gives up.
    errored: enabled && catalogQuery.isError,
    isLoading: enabled && answered === undefined && catalogQuery.isFetching,
    // The set alone decides the refresh half. `refreshMutation.isPending` is
    // the OBSERVER's state, and the observer tracks only the latest `mutate()`
    // call - the moment a newer refresh settles it reads false while an older
    // one is still in flight, which re-forgot exactly the A→B→A walk the set
    // exists to remember. The set needs no corroboration: it is maintained by
    // the mutation-level callbacks, which fire for replaced mutations too.
    isChecking:
      enabled &&
      (catalogQuery.isFetching || pendingRefreshKeys.has(hashKey(cacheKey))),
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
