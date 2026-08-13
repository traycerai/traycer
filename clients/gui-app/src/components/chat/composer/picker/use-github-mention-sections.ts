import { useCallback, useMemo, useState } from "react";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GithubMentionRepository,
  GithubMentionRow,
  GithubMentionSection,
} from "@traycer/protocol/host/mention-schemas";

import { useGithubMentionCatalog } from "@/hooks/composer/use-github-mention-catalog";
import type {
  GithubMentionCatalogResult,
  GithubMentionScope,
} from "@/hooks/composer/use-github-mention-catalog";
import { useGithubMentionSearch } from "@/hooks/composer/use-github-mention-search";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";
import { useSampledNow } from "@/lib/relative-time";
import {
  filterGithubMentionRows,
  githubMentionChromeFor,
  githubMentionScopeKey,
  githubMentionSectionForStep,
  githubMentionRowsForSection,
  githubMentionRowsWithinScope,
  mergeGithubMentionRows,
  rankGithubMentionRows,
  type GithubMentionFilter,
  type GithubMentionProviderContext,
  type GithubMentionSectionContext,
  type MentionFlowStep,
  type MentionStepChrome,
} from "@/lib/composer/mentions";
import {
  reconcileRepositorySelection,
  selectGithubMentionFilter,
  useGithubMentionFilterStore,
} from "@/stores/composer/github-mention-filter-store";

/**
 * Everything the two GitHub mention sections need, in one place: which rows to
 * show for the current step, and the chrome that step publishes.
 *
 * Both sections are read cache-only at ROOT so root search has warm rows
 * without ever touching the network per keystroke; only the section the user
 * has actually drilled into runs the stale follow-up and the live search.
 */

const EMPTY_ROWS: ReadonlyArray<GithubMentionRow> = [];
const EMPTY_REPOSITORIES: ReadonlyArray<GithubMentionRepository> = [];

export interface UseGithubMentionSectionsParams {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly active: boolean;
  readonly step: MentionFlowStep;
  readonly currentEpicId: string | null;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly query: string;
  readonly debouncedQuery: string;
  readonly limit: number;
}

export interface GithubMentionSectionsResult {
  readonly context: GithubMentionProviderContext;
  /** Null unless the picker is inside one of the two GitHub sections. */
  readonly chrome: MentionStepChrome | null;
  /** True while the OPEN section has nothing cached to render yet. */
  readonly loading: boolean;
  /** True while something is in flight BEHIND rows already on screen. */
  readonly checking: boolean;
  /**
   * A REQUESTED GitHub read failed outright - no answer, not a degraded one.
   * Covers both catalog lanes and the open section's live search; each source
   * reports only while its own read is enabled, so a section nobody asked
   * contributes nothing. The zero-match dismissal folds this in beside the
   * workspace, epic and terminal errors: without it, a failed GitHub source
   * read as "settled and empty" and closed the picker over rows it never saw.
   */
  readonly errored: boolean;
}

export function useGithubMentionSections(
  params: UseGithubMentionSectionsParams,
): GithubMentionSectionsResult {
  const {
    client,
    active,
    step,
    currentEpicId,
    mentionRoots,
    query,
    debouncedQuery,
    limit,
  } = params;

  const openSection = githubMentionSectionForStep(step);
  const atRoot = step.kind === "root";
  const readiness = useReactiveHostReadiness(client);
  const hostId = readiness.hostId;
  // Both methods are optional (non-floor) RPCs, so an older host negotiates
  // them away instead of failing the handshake. `useHostSupportsMethod` fails
  // closed, which is what keeps the categories hidden - rather than present
  // and permanently empty - until a manifest proves both are there.
  const catalogSupported = useHostSupportsMethod(
    hostId,
    "mention.githubCatalog",
  );
  const searchSupported = useHostSupportsMethod(hostId, "mention.githubSearch");
  const supported = catalogSupported && searchSupported;
  const scope = useMemo<GithubMentionScope>(
    () => ({ epicId: currentEpicId, workspacePaths: mentionRoots }),
    [currentEpicId, mentionRoots],
  );
  const scopeKey = useMemo(
    () =>
      githubMentionScopeKey({
        hostId,
        epicId: currentEpicId,
        workspacePaths: mentionRoots,
      }),
    [currentEpicId, hostId, mentionRoots],
  );

  // The shared 60s clock, not `Date.now()`: every row's relative age in one
  // render agrees, the labels re-tick with the rest of the app, and reading it
  // during render stays pure.
  const now = useSampledNow();

  // `pickerActive` is the menu session, and it is deliberately NOT `enabled`:
  // each read is disabled while the other section is open, and the follow-up
  // guard must outlive that - see `UseGithubMentionCatalogParams.pickerActive`.
  const pickerActive = supported && active;
  const pullRequestCatalog = useGithubMentionCatalog({
    client,
    scope,
    section: "pull-requests",
    enabled: pickerActive && (atRoot || openSection === "pull-requests"),
    allowStaleFollowUp: openSection === "pull-requests",
    pickerActive,
  });
  const issueCatalog = useGithubMentionCatalog({
    client,
    scope,
    section: "issues",
    enabled: pickerActive && (atRoot || openSection === "issues"),
    allowStaleFollowUp: openSection === "issues",
    pickerActive,
  });

  // The query entries are the ONLY copy of the catalog rows - root search
  // ranks these two reads' answers directly. Their entries stay warm across
  // menu sessions (`gcTime` is set for exactly that in the catalog hook), so
  // there is no session store to publish into, keep synchronized, or catch
  // serving rows a fresher resolution already invalidated: a scope that
  // drifts re-keys the read instead.
  const scopeAnswer = preferredScopeAnswer(
    openSection,
    pullRequestCatalog,
    issueCatalog,
  );
  const scopeResolved = scopeAnswer.scopeResolved;
  const queryRepositories = scopeAnswer.repositories;

  const openCatalog =
    openSection === "issues" ? issueCatalog : pullRequestCatalog;

  // The HOST's resolved scope, not one inferred from the rows. Three things
  // turn on that: the Repository group renders against a cold cache (no row has
  // to have arrived yet), `repositories: []` is an authoritative "these folders
  // hold no GitHub repo" that no amount of row-counting can prove, and the
  // chip's `#123` vs `repo#123` label is a property of the SCOPE.
  //
  // Read from whichever section has answered, because the scope is a property
  // of the attached folders and both sections are asked about the same ones.
  // Keying it to the open section instead would leave it empty at root - and
  // then the same PR would insert `repo#4917` when picked from root search and
  // `#4917` when picked inside the section, which is the entry point changing
  // the chip.
  const {
    filter: scopeRepositories,
    qualification: qualificationRepositories,
  } = scopeRepositoryFacts(scopeResolved, queryRepositories);

  // The row boundary the resolved scope implies, or `null` while no answer
  // exists to imply one. `scopeResolved` already names the freshest RESOLVED
  // answer across BOTH sections, and that answer's repository set is
  // authoritative for every row surface - including rows that arrived under an
  // OLDER resolution. Two carriers still hold such rows: the sibling section's
  // catalog entry inside its `staleTime`, and a held search response predating
  // the change. A repository removed (or a remote changed) is discovered by
  // whichever section refreshes first; without this, the other carrier keeps
  // showing - and inserting - references from the departed repository until
  // its own cache expires.
  //
  // `null` (not `[]`) while unresolved: no authority exists yet, and the row
  // surfaces below serve nothing in that window anyway. An empty RESOLVED set
  // stays a filter: "these folders hold no GitHub repo" is authoritative, and
  // rows surviving it would be exactly the leak this boundary exists to stop.
  const resolvedScopeRepositories = scopeResolved ? queryRepositories : null;

  const storedFilter = useGithubMentionFilterStore((state) =>
    selectGithubMentionFilter(
      state,
      currentEpicId,
      openSection ?? "pull-requests",
    ),
  );
  // Reconciled ONCE, here, and published through the chrome - so the list, the
  // radios, and the funnel's dot cannot disagree about what is selected. The
  // popover used to re-read the raw store, which meant a stored repo that had
  // left the scope produced an unfiltered list, a lit dot claiming a filter was
  // active, and a Repository group with nothing selected - three symptoms of
  // one split source of truth.
  //
  // Not reconciled until the host has actually answered: an unresolved scope is
  // an empty `repositories`, and reconciling against it would clear a
  // legitimate selection for one paint on every cold open.
  const filter = useMemo<GithubMentionFilter>(
    () =>
      scopeResolved
        ? reconcileRepositorySelection(
            openSection ?? "pull-requests",
            storedFilter,
            scopeRepositories,
          )
        : storedFilter,
    [openSection, scopeRepositories, scopeResolved, storedFilter],
  );

  const search = useGithubMentionSearch({
    client,
    scope,
    section: openSection ?? "pull-requests",
    debouncedQuery,
    filter,
    // `supported` belongs here as much as on the catalog reads: it is reactive
    // to `hostId`, so a host swap - or an in-place downgrade that re-handshakes
    // - can negotiate the method away while this section stays open. Without
    // it, typing would keep calling a method the current host never declared.
    //
    // The scope clause covers the window `filter` above deliberately leaves
    // unreconciled. A selection is kept through an unresolved scope so a cold
    // open does not blank it for one paint - correct for the radios and the
    // funnel dot, which only DISPLAY it, and wrong for this read, which SENDS
    // it. A repository selection is non-default, so `wanted` is satisfied with
    // no query typed at all: the roots changing under an open section is on its
    // own enough to spend a request qualified by a repository that may have
    // just left the scope, and to offer its rows as insertable. Withheld only
    // while something is selected, so the common unfiltered open still searches
    // the moment the user types.
    enabled:
      supported &&
      active &&
      openSection !== null &&
      (scopeResolved || filter.repository === null),
  });

  // The debounce gap is PENDING, not settled: `query` filters the visible
  // rows immediately, but the search above still holds the previous
  // `debouncedQuery` for up to 250ms - so a query with no cached match would
  // otherwise render the authoritative "No matching…" answer before the
  // remote request it is owed has even started. Scoped to the search's own
  // conditions: a query no search will ever run for (unsupported host,
  // withheld selection, no section open) really is settled.
  const searching = searchActivity({
    isSearching: search.isSearching,
    supported,
    active,
    openSection,
    scopeResolved,
    repositorySelected: filter.repository !== null,
    query,
    debouncedQuery,
  });

  // The section's list: cached rows first (identity preserved), remote hits
  // appended, the funnel applied, then ranked. Filtering AFTER the merge is
  // deliberate - a remote hit that the filter excludes was fetched under those
  // same qualifiers, so it can only be excluded by a filter the user changed
  // while it was in flight.
  const localRows = useMemo<ReadonlyArray<GithubMentionRow>>(() => {
    if (openSection === null) return EMPTY_ROWS;
    // Both inputs are narrowed to this section's entity type FIRST. The search
    // observer is the one that can hand over the other section's rows (see
    // `githubMentionRowsForSection`); the catalog is narrowed too because the
    // cost is a single `every` on an already-correct array, and a boundary
    // enforced on only one of two inputs is a boundary someone can walk around.
    const merged = mergeGithubMentionRows(
      githubMentionRowsForSection(openCatalog.rows, openSection),
      githubMentionRowsForSection(search.rows, openSection),
    );
    // The repository boundary is applied to the MERGE, not to one input: this
    // section's catalog can be the stale sibling (see
    // `resolvedScopeRepositories`), and a held search response predating a
    // scope change is the same row under the other arm.
    const scoped =
      resolvedScopeRepositories === null
        ? merged
        : githubMentionRowsWithinScope(merged, resolvedScopeRepositories);
    return rankGithubMentionRows({
      rows: filterGithubMentionRows(scoped, openSection, filter),
      section: openSection,
      query,
      limit,
    });
  }, [
    filter,
    limit,
    openCatalog.rows,
    openSection,
    query,
    resolvedScopeRepositories,
    search.rows,
  ]);

  // Changing a funnel must not flash the list away and back.
  //
  // The catalog only ever sweeps the DEFAULT view, so a filter it cannot answer
  // - `State: Merged` over a cache of open PRs - excludes every cached row the
  // instant it is selected, and the only thing left to render is the appended
  // `Searching GitHub…` row. The menu collapsed from a full list to one line
  // and back on every filter change, and while the remote was slow or paused
  // that empty frame read as "changing the filter does nothing".
  //
  // An empty local list under an in-flight search is "not answered yet", not
  // "nothing matches", so the rows already on screen stay until the answer
  // lands - the `keepPreviousData` bargain, applied one layer up, where the
  // funnel is actually applied.
  const openRows = useHeldRowsDuringSearch({
    rows: localRows,
    searching,
    // Keyed so the hold is only ever a FILTER swap. A new query, a different
    // section, or a different SCOPE is a different question, and answering it
    // with the previous question's rows would be the lie this exists to avoid.
    // The scope term is the load-bearing one: holding across a host, epic or
    // roots change would offer rows the new scope cannot resolve, and the user
    // could commit one as a mention.
    key: `${scopeKey}\x1f${openSection ?? ""}\x1f${query}`,
  });

  // Root rows are cache-only and unfiltered: the funnel is the SECTION's
  // control, and a narrowing set there must not quietly hide rows from the
  // flat cross-source list the user gets by typing at `@`.
  const rootPullRequestRows = useRootRows({
    catalog: pullRequestCatalog,
    section: "pull-requests",
    atRoot,
    query,
    limit,
    resolvedScopeRepositories,
  });
  const rootIssueRows = useRootRows({
    catalog: issueCatalog,
    section: "issues",
    atRoot,
    query,
    limit,
    resolvedScopeRepositories,
  });

  const context = useMemo<GithubMentionProviderContext>(
    () => ({
      pullRequests: sectionContext(
        openSection === "pull-requests" ? openRows.rows : rootPullRequestRows,
        openSection === "pull-requests" && openRows.held,
        qualificationRepositories,
      ),
      issues: sectionContext(
        openSection === "issues" ? openRows.rows : rootIssueRows,
        openSection === "issues" && openRows.held,
        qualificationRepositories,
      ),
      supported,
      now,
    }),
    [
      now,
      openRows,
      openSection,
      qualificationRepositories,
      rootIssueRows,
      rootPullRequestRows,
      supported,
    ],
  );

  // One button over a list that is two reads merged. The catalog alone leaves
  // a typed query's rows, and the search's own notice and status, untouched -
  // so a refresh pressed BECAUSE the section reports `gh` unavailable would
  // leave that report standing.
  const { refreshManually } = openCatalog;
  const { refresh: refreshSearch } = search;
  const onRefresh = useCallback(async () => {
    await Promise.all([refreshManually(), refreshSearch()]);
  }, [refreshManually, refreshSearch]);

  const chrome = useMemo<MentionStepChrome | null>(() => {
    // The chrome is gated on everything the READS are gated on, because its
    // refresh button reaches the host directly and would otherwise outlive
    // them both:
    //
    // - `supported` is reactive. An app-wide composer can rebind to an older
    //   host, or the bound host can re-handshake after an in-place downgrade,
    //   while a GitHub step is open; the button would then call a method this
    //   handshake negotiated away.
    // - an empty scope is a WIRE error, not a quiet no-op:
    //   `mentionGithubCatalogRequestSchema` requires `workspacePaths.min(1)`,
    //   so refreshing after the last folder is detached fails validation
    //   rather than returning nothing.
    if (
      openSection === null ||
      !supported ||
      scope.workspacePaths.length === 0
    ) {
      return null;
    }
    // Every decision below - ⓘ suppression, banner, empty-scope copy - lives in
    // `githubMentionChromeFor`, which is pure and directly tested. This hook
    // only supplies what the host said.
    return githubMentionChromeFor({
      section: openSection,
      scopeKey,
      epicId: currentEpicId,
      repositories: scopeRepositories,
      selected: filter,
      scopeResolved: openCatalog.scopeResolved,
      sourceStatus: openCatalog.sourceStatus,
      catalogNotice: openCatalog.notice,
      searchNotice: search.notice,
      searchSourceStatus: search.sourceStatus,
      freshnessAt: openCatalog.freshnessAt,
      checking: openCatalog.isChecking,
      searching,
      // The OPEN section's own failures only - the sibling catalog's belong
      // to the root dismissal union below, not to this section's chrome.
      errored: openCatalog.errored || search.errored,
      onRefresh,
    });
  }, [
    currentEpicId,
    filter,
    onRefresh,
    openCatalog.errored,
    openCatalog.freshnessAt,
    openCatalog.isChecking,
    openCatalog.notice,
    openCatalog.scopeResolved,
    openCatalog.sourceStatus,
    openSection,
    scopeRepositories,
    searching,
    scope.workspacePaths,
    search.errored,
    search.notice,
    search.sourceStatus,
    supported,
    scopeKey,
  ]);

  return {
    context,
    chrome,
    errored: anyGithubSourceErrored(pullRequestCatalog, issueCatalog, search),
    ...sectionActivity({
      atRoot,
      openSection,
      openCatalog,
      pullRequests: pullRequestCatalog,
      issues: issueCatalog,
      openRowCount: openRows.rows.length,
      query,
    }),
  };
}

/**
 * What the picker should report as in-flight, which differs by step.
 *
 * At ROOT both catalogs are read cache-only, and those reads gate the
 * zero-match dismissal too: root search ranks their ANSWERS, which are empty
 * until they land. Reporting nothing there let a title query whose 250 ms
 * debounce settled first see zero matches with nothing loading, and the
 * zero-match rule closed the picker moments before the cached PRs and issues
 * it was about to match arrived.
 *
 * Inside a section only that section's catalog matters - and `checking` covers
 * a background refetch behind rows already on screen, which core flows asks to
 * render exactly like Artifacts (header spinner AND `Checking…` stamp).
 */
function sectionActivity(input: {
  readonly atRoot: boolean;
  readonly openSection: GithubMentionSection | null;
  readonly openCatalog: GithubMentionCatalogResult;
  readonly pullRequests: GithubMentionCatalogResult;
  readonly issues: GithubMentionCatalogResult;
  readonly openRowCount: number;
  readonly query: string;
}): { readonly loading: boolean; readonly checking: boolean } {
  if (input.atRoot) {
    // Root renders no catalog rows until the user types - its category list
    // is complete on its own. So the hydration reads only count once a query
    // exists for them to answer: on a cold open with an empty query they
    // would put up a Loading row and a header spinner for work that cannot
    // change what is on screen. The live query, not the debounced one, so
    // the gate arms with the first keystroke.
    const rootSearchPending = input.query.trim().length > 0;
    return {
      loading:
        rootSearchPending &&
        (input.pullRequests.isLoading || input.issues.isLoading),
      checking:
        rootSearchPending &&
        (input.pullRequests.isChecking || input.issues.isChecking),
    };
  }
  if (input.openSection === null) return { loading: false, checking: false };
  return {
    loading: input.openCatalog.isLoading && input.openRowCount === 0,
    checking: input.openCatalog.isChecking,
  };
}

function sectionContext(
  rows: ReadonlyArray<GithubMentionRow>,
  rowsHeld: boolean,
  repositories: ReadonlyArray<GithubMentionRepository> | null,
): GithubMentionSectionContext {
  return { rows, rowsHeld, repositories };
}

/**
 * The search's in-flight projection, INCLUDING the debounce window. True for
 * a query the search WILL run but has not started: same conditions as the
 * search read's own `enabled`, plus a non-empty live query (clearing the
 * query needs no search - the cached rows are already the answer).
 */
function searchActivity(input: {
  readonly isSearching: boolean;
  readonly supported: boolean;
  readonly active: boolean;
  readonly openSection: GithubMentionSection | null;
  readonly scopeResolved: boolean;
  readonly repositorySelected: boolean;
  readonly query: string;
  readonly debouncedQuery: string;
}): boolean {
  if (input.isSearching) return true;
  if (!input.supported || !input.active || input.openSection === null) {
    return false;
  }
  if (!input.scopeResolved && input.repositorySelected) return false;
  return input.query.trim().length > 0 && input.query !== input.debouncedQuery;
}

/**
 * Every GitHub read that can fail outright, in one place: both catalog lanes
 * AND the open section's live search. Each source is already requested-gated
 * (an idle read cannot report), so this is a plain union. The search belongs
 * here because its rejection has the same downstream lie as a catalog's: no
 * rows, `isSearching` false, and a zero-match verdict that closes the picker
 * over hits the request never returned.
 */
function anyGithubSourceErrored(
  pullRequests: GithubMentionCatalogResult,
  issues: GithubMentionCatalogResult,
  search: { readonly errored: boolean },
): boolean {
  return pullRequests.errored || issues.errored || search.errored;
}

/**
 * Keeps the last answered row set on screen while a search for the SAME
 * question is in flight. See the call site for why a filter swap needs it.
 *
 * State adjusted DURING render rather than in an effect. An effect would paint
 * the collapsed frame first and only then correct it, which is the exact frame
 * this exists to remove; a ref would be read during render, which the compiler
 * rejects and which would not re-render on its own anyway. React re-runs this
 * render pass before committing, so the set converges in one paint.
 */
function useHeldRowsDuringSearch(input: {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  readonly searching: boolean;
  readonly key: string;
}): HeldRowsResult {
  const { rows, searching, key } = input;
  const [held, setHeld] = useState<HeldRows | null>(null);
  // A settled answer is always authoritative - INCLUDING a settled empty one,
  // which is how "no merged pull requests here" survives rather than being
  // papered over by whatever happened to be on screen before it.
  const answered = !searching || rows.length > 0;
  if (answered) {
    const next = rows.length > 0 ? { key, rows } : null;
    if (!sameHeldRows(held, next)) setHeld(next);
    return { rows, held: false };
  }
  return held !== null && held.key === key
    ? { rows: held.rows, held: true }
    : { rows, held: false };
}

interface HeldRows {
  readonly key: string;
  readonly rows: ReadonlyArray<GithubMentionRow>;
}

interface HeldRowsResult {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  /**
   * True while `rows` is the PREVIOUS question's answer standing in for the
   * current one. The consumer must publish held rows as non-selectable: the
   * funnel already claims the new filter, and committing a row the new filter
   * never matched would insert a mention under a claim the list is not
   * making.
   */
  readonly held: boolean;
}

/**
 * The two repository facts one resolved scope answer yields, split by the
 * question each serves.
 *
 * `filter` stays an array and is empty until the scope resolves - safe for
 * the FILTER surfaces (the Repository group hides, reconciliation is gated on
 * `scopeResolved`). `qualification` is the collision authority for row and
 * chip labels, and there "unresolved" must stay `null` rather than masquerade
 * as an authoritative empty set: rows do not all come from catalog answers -
 * the live search runs under an unresolved scope whenever no repository is
 * selected, so a typed query can put rows on screen while no collision answer
 * exists, and null makes `githubRepositoryQualification` print `owner/repo`
 * instead of a bare `#123` no answer has proven unambiguous.
 */
function scopeRepositoryFacts(
  scopeResolved: boolean,
  queryRepositories: ReadonlyArray<GithubMentionRepository>,
): {
  readonly filter: ReadonlyArray<GithubMentionRepository>;
  readonly qualification: ReadonlyArray<GithubMentionRepository> | null;
} {
  return scopeResolved
    ? { filter: queryRepositories, qualification: queryRepositories }
    : { filter: EMPTY_REPOSITORIES, qualification: null };
}

/** Identity comparison; the row array is never rebuilt for an unchanged answer. */
function sameHeldRows(left: HeldRows | null, right: HeldRows | null): boolean {
  if (left === null || right === null) return left === right;
  return left.key === right.key && left.rows === right.rows;
}

/**
 * Whichever catalog's `repositories` answer should be believed right now.
 *
 * Both sections are asked about the same folders, so either answer is valid -
 * the question is only which one can have SEEN a repository added, removed or
 * renamed. `answeredAt` - when the answer REACHED THE CLIENT - answers that
 * directly, and position never does: reading pull-requests first
 * unconditionally left the Repository group, the empty-scope copy and the
 * `repo#123` chip label on scope data an Issues refresh had already
 * invalidated. `freshnessAt` cannot be the clock here even though it reads
 * like one: it stamps the host's last successful GitHub reach, and a degraded
 * sweep re-resolves `repositories` from the folders' remotes WITHOUT
 * advancing it - compared on `freshnessAt`, the sibling's older, wider
 * repository set outranked the very resolution that saw a repository leave.
 *
 * Which section is open only breaks the TIE. Preferring the open one outright
 * has the same failure in a different place - refresh Pull requests, step
 * straight into Issues, and the older Issues answer wins on being open and
 * drives every scope surface, with nothing to correct it because a 60s
 * `staleTime` covers exactly that window and suppresses the refetch.
 *
 * The unresolved cases come first because an answer that does not exist cannot
 * be compared: `answeredAt` is null there, and treating null as oldest would
 * confuse "not yet answered" with "answered long ago".
 */
function preferredScopeAnswer(
  openSection: GithubMentionSection | null,
  pullRequests: GithubMentionCatalogResult,
  issues: GithubMentionCatalogResult,
): GithubMentionCatalogResult {
  const preferred = openSection === "issues" ? issues : pullRequests;
  const other = openSection === "issues" ? pullRequests : issues;
  if (!preferred.scopeResolved) return other;
  if (!other.scopeResolved) return preferred;
  // Arrival recency decides between two resolved answers, INCLUDING when one
  // of them is the open section's. Being open earns the tie, not the
  // comparison: the other query can be sitting on a newer answer and still
  // not refetch, because a 60s `staleTime` covers exactly the window in which
  // a user refreshes one section and steps straight into the other.
  return (other.answeredAt ?? 0) > (preferred.answeredAt ?? 0)
    ? other
    : preferred;
}

interface RootRowsInput {
  readonly catalog: GithubMentionCatalogResult;
  readonly section: GithubMentionSection;
  readonly atRoot: boolean;
  readonly query: string;
  readonly limit: number;
  /**
   * The freshest resolved answer's repositories across BOTH sections, or
   * `null` while neither has resolved. Root reaches insertable rows without
   * passing through the open section's merge, so the repository boundary is
   * enforced here too - this section's entry can still be inside `staleTime`
   * while its sibling already learned a repository left.
   */
  readonly resolvedScopeRepositories: ReadonlyArray<GithubMentionRepository> | null;
}

/**
 * Root's rows for one section: what THIS scope's catalog has answered, or
 * nothing.
 *
 * Nothing, deliberately, in both unanswered windows. A placeholder is the
 * PREVIOUS scope's answer, and serving it would offer rows the current scope
 * cannot resolve as insertable mentions; an unresolved read has said nothing
 * at all. Neither window renders a false zero-match verdict, because the
 * hydration reads gate `loading` for exactly as long as they are unanswered
 * (see `sectionActivity`'s root branch) - a brief Loading row where a
 * session-lived row store used to serve whatever an older resolution left
 * behind.
 */
function useRootRows(input: RootRowsInput): ReadonlyArray<GithubMentionRow> {
  const { catalog, section, atRoot, query, limit, resolvedScopeRepositories } =
    input;
  const { rows: catalogRows, isPlaceholder, scopeResolved } = catalog;
  return useMemo(() => {
    if (!atRoot || query.trim().length === 0) return EMPTY_ROWS;
    if (isPlaceholder || !scopeResolved) return EMPTY_ROWS;
    const rows = githubMentionRowsForSection(catalogRows, section);
    const scoped =
      resolvedScopeRepositories === null
        ? rows
        : githubMentionRowsWithinScope(rows, resolvedScopeRepositories);
    return rankGithubMentionRows({ rows: scoped, section, query, limit });
  }, [
    atRoot,
    catalogRows,
    isPlaceholder,
    limit,
    query,
    resolvedScopeRepositories,
    scopeResolved,
    section,
  ]);
}
