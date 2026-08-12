import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
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
  mergeGithubMentionRows,
  rankGithubMentionRows,
  type GithubMentionFilter,
  type GithubMentionProviderContext,
  type GithubMentionSectionContext,
  type MentionFlowStep,
  type MentionStepChrome,
} from "@/lib/composer/mentions";
import {
  selectGithubMentionCatalogRows,
  selectGithubMentionScopeRepositories,
  useGithubMentionCatalogStore,
} from "@/stores/composer/github-mention-catalog-store";
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

  const pullRequestCatalog = useGithubMentionCatalog({
    client,
    scope,
    section: "pull-requests",
    enabled: supported && active && (atRoot || openSection === "pull-requests"),
    allowStaleFollowUp: openSection === "pull-requests",
  });
  const issueCatalog = useGithubMentionCatalog({
    client,
    scope,
    section: "issues",
    enabled: supported && active && (atRoot || openSection === "issues"),
    allowStaleFollowUp: openSection === "issues",
  });

  const catalogStore = useGithubMentionCatalogStore(
    useShallow((state) => ({
      setRows: state.setRows,
      setRepositories: state.setRepositories,
      pullRequests: selectGithubMentionCatalogRows(
        state,
        scopeKey,
        "pull-requests",
      ),
      issues: selectGithubMentionCatalogRows(state, scopeKey, "issues"),
      repositories: selectGithubMentionScopeRepositories(state, scopeKey),
    })),
  );
  const { setRows, setRepositories } = catalogStore;

  // Root search reads the store, not these queries: the section unmounts its
  // observers when the menu closes, and a warm host cache must still serve the
  // flat root list on the next open.
  //
  // Two guards on every write, and both are the same rule as the `openRows`
  // merge:
  //
  // - `isPlaceholder` - render stale, do not RECORD stale. A placeholder is the
  //   previous scope's answer; writing it under the current `scopeKey` would
  //   persist it past the window the placeholder covers.
  // - `githubMentionRowsForSection` - the root path reaches insertable rows
  //   WITHOUT passing through `openRows`, so a boundary enforced only there is
  //   a boundary this path walks around. It costs one `every` over an
  //   already-correct array.
  // The third guard is `scopeResolved`, and it is why the empty case is a
  // WRITE rather than a skip. An empty list has two completely different
  // meanings here:
  //
  // - the host has not answered yet - `rows` is `[]` only because there is no
  //   response, and writing it would blank a warm store that is currently the
  //   only thing serving root search;
  // - the host answered and this scope genuinely has no open items - which is
  //   as authoritative as any other answer. Skipping it strands the previous
  //   non-empty result in a session-lived store, so root search keeps offering
  //   PRs that were closed hours ago, indefinitely and invisibly.
  //
  // `scopeResolved` is exactly "the host answered", so it separates the two.
  useCatalogRowPublication({
    catalog: pullRequestCatalog,
    section: "pull-requests",
    scopeKey,
    setRows,
  });
  useCatalogRowPublication({
    catalog: issueCatalog,
    section: "issues",
    scopeKey,
    setRows,
  });

  // The scope's repositories persist beside the rows because the two are read
  // together by a root-search row and must share ONE lifetime. The query
  // entries carry TanStack's default 5-minute `gcTime`; this store is
  // session-lived. Without this, reopening the menu past that window serves
  // rows from the warm store while the query answers `undefined`, and a
  // single-repo scope starts labelling its chips `repo#123`.
  const scopeAnswer = preferredScopeAnswer(
    openSection,
    pullRequestCatalog,
    issueCatalog,
  );
  // Read the three FIELDS out before the effect. `useGithubMentionCatalog`
  // builds its result fresh on every render, so depending on the whole object
  // re-runs this effect every pass; the fields are the stable values the two
  // row effects above already depend on.
  const scopeResolved = scopeAnswer.scopeResolved;
  const scopeAnswerIsPlaceholder = scopeAnswer.isPlaceholder;
  const queryRepositories = scopeAnswer.repositories;
  useEffect(() => {
    if (!scopeResolved || scopeAnswerIsPlaceholder) return;
    setRepositories({ scopeKey, repositories: queryRepositories });
  }, [
    queryRepositories,
    scopeAnswerIsPlaceholder,
    scopeKey,
    scopeResolved,
    setRepositories,
  ]);

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
  // Live query answer first (`queryRepositories`, resolved above); the
  // persisted one when neither query has answered for this scope yet (a warm
  // store outliving a garbage-collected query entry is exactly the case that
  // mislabels a chip at root).
  const scopeRepositories = scopeResolved
    ? queryRepositories
    : catalogStore.repositories;

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
    enabled: active && openSection !== null,
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
    return rankGithubMentionRows({
      rows: filterGithubMentionRows(merged, openSection, filter),
      section: openSection,
      query,
      limit,
    });
  }, [filter, limit, openCatalog.rows, openSection, query, search.rows]);

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
    searching: search.isSearching,
    // Keyed so the hold is only ever a FILTER swap. A new query or a different
    // section is a different question, and answering it with the previous
    // question's rows would be the lie this exists to avoid.
    key: `${openSection ?? ""}\x1f${query}`,
  });

  // Root rows are cache-only and unfiltered: the funnel is the SECTION's
  // control, and a narrowing set there must not quietly hide rows from the
  // flat cross-source list the user gets by typing at `@`.
  const rootPullRequestRows = useRootRows({
    rows: catalogStore.pullRequests,
    section: "pull-requests",
    atRoot,
    query,
    limit,
  });
  const rootIssueRows = useRootRows({
    rows: catalogStore.issues,
    section: "issues",
    atRoot,
    query,
    limit,
  });

  const singleRepositoryScope = scopeRepositories.length === 1;
  const context = useMemo<GithubMentionProviderContext>(
    () => ({
      pullRequests: sectionContext(
        openSection === "pull-requests" ? openRows : rootPullRequestRows,
        singleRepositoryScope,
      ),
      issues: sectionContext(
        openSection === "issues" ? openRows : rootIssueRows,
        singleRepositoryScope,
      ),
      supported,
      now,
    }),
    [
      now,
      openRows,
      openSection,
      rootIssueRows,
      rootPullRequestRows,
      singleRepositoryScope,
      supported,
    ],
  );

  const chrome = useMemo<MentionStepChrome | null>(() => {
    if (openSection === null) return null;
    // Every decision below - ⓘ suppression, banner, empty-scope copy - lives in
    // `githubMentionChromeFor`, which is pure and directly tested. This hook
    // only supplies what the host said.
    return githubMentionChromeFor({
      section: openSection,
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
      searching: search.isSearching,
      onRefresh: openCatalog.refreshManually,
    });
  }, [
    currentEpicId,
    filter,
    openCatalog.freshnessAt,
    openCatalog.isChecking,
    openCatalog.notice,
    openCatalog.refreshManually,
    openCatalog.scopeResolved,
    openCatalog.sourceStatus,
    openSection,
    scopeRepositories,
    search.isSearching,
    search.notice,
    search.sourceStatus,
  ]);

  return {
    context,
    chrome,
    ...sectionActivity({
      atRoot,
      openSection,
      openCatalog,
      pullRequests: pullRequestCatalog,
      issues: issueCatalog,
      openRowCount: openRows.length,
    }),
  };
}

/**
 * What the picker should report as in-flight, which differs by step.
 *
 * At ROOT both catalogs are read cache-only to warm the row store, and those
 * reads gate the zero-match dismissal too: root search reads the STORE, which
 * stays empty until they land. Reporting nothing there let a title query whose
 * 250 ms debounce settled first see zero matches with nothing loading, and the
 * zero-match rule closed the picker moments before the cached PRs and issues
 * it was about to match were published.
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
}): { readonly loading: boolean; readonly checking: boolean } {
  if (input.atRoot) {
    return {
      loading: input.pullRequests.isLoading || input.issues.isLoading,
      checking: input.pullRequests.isChecking || input.issues.isChecking,
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
  singleRepositoryScope: boolean,
): GithubMentionSectionContext {
  return { rows, singleRepositoryScope };
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
}): ReadonlyArray<GithubMentionRow> {
  const { rows, searching, key } = input;
  const [held, setHeld] = useState<HeldRows | null>(null);
  // A settled answer is always authoritative - INCLUDING a settled empty one,
  // which is how "no merged pull requests here" survives rather than being
  // papered over by whatever happened to be on screen before it.
  const answered = !searching || rows.length > 0;
  if (answered) {
    const next = rows.length > 0 ? { key, rows } : null;
    if (!sameHeldRows(held, next)) setHeld(next);
    return rows;
  }
  return held !== null && held.key === key ? held.rows : rows;
}

interface HeldRows {
  readonly key: string;
  readonly rows: ReadonlyArray<GithubMentionRow>;
}

/** Identity comparison; the row array is never rebuilt for an unchanged answer. */
function sameHeldRows(left: HeldRows | null, right: HeldRows | null): boolean {
  if (left === null || right === null) return left === right;
  return left.key === right.key && left.rows === right.rows;
}

/**
 * Whichever catalog's `repositories` answer should be believed right now.
 *
 * Both sections are asked about the same folders, so either one's answer is
 * valid - but only the OPEN one is being refreshed, so it is the one that can
 * have observed an added, removed or renamed repository. Reading pull-requests
 * first unconditionally left the Repository group, the empty-scope copy and
 * the `repo#123` chip label on scope data an Issues refresh had already
 * invalidated. The other section is the fallback for the window before the
 * open one has answered at all - including at root, where neither is open.
 */
function preferredScopeAnswer(
  openSection: GithubMentionSection | null,
  pullRequests: GithubMentionCatalogResult,
  issues: GithubMentionCatalogResult,
): GithubMentionCatalogResult {
  const preferred = openSection === "issues" ? issues : pullRequests;
  if (preferred.scopeResolved) return preferred;
  return openSection === "issues" ? pullRequests : issues;
}

/**
 * Publishes one section's resolved rows into the session store that root
 * search reads.
 *
 * A hook rather than two inline effects so the two sections cannot drift, and
 * so the guards are stated once. See the note at the call site for why an
 * authoritative empty is a WRITE and an unanswered one is not.
 */
function useCatalogRowPublication(input: {
  readonly catalog: GithubMentionCatalogResult;
  readonly section: GithubMentionSection;
  readonly scopeKey: string;
  readonly setRows: (write: {
    readonly scopeKey: string;
    readonly section: GithubMentionSection;
    readonly rows: ReadonlyArray<GithubMentionRow>;
  }) => void;
}): void {
  const { catalog, section, scopeKey, setRows } = input;
  const { isPlaceholder, scopeResolved, rows } = catalog;
  useEffect(() => {
    if (isPlaceholder) return;
    if (!scopeResolved) return;
    setRows({
      scopeKey,
      section,
      rows: githubMentionRowsForSection(rows, section),
    });
  }, [isPlaceholder, rows, scopeKey, scopeResolved, section, setRows]);
}

interface RootRowsInput {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  readonly section: GithubMentionSection;
  readonly atRoot: boolean;
  readonly query: string;
  readonly limit: number;
}

function useRootRows(input: RootRowsInput): ReadonlyArray<GithubMentionRow> {
  const { rows, section, atRoot, query, limit } = input;
  return useMemo(() => {
    if (!atRoot || query.trim().length === 0) return EMPTY_ROWS;
    return rankGithubMentionRows({ rows, section, query, limit });
  }, [atRoot, limit, query, rows, section]);
}
