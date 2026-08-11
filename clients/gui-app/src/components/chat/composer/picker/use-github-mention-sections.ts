import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GithubMentionRow,
  GithubMentionSection,
} from "@traycer/protocol/host/mention-schemas";

import { useGithubMentionCatalog } from "@/hooks/composer/use-github-mention-catalog";
import type { GithubMentionScope } from "@/hooks/composer/use-github-mention-catalog";
import { useGithubMentionSearch } from "@/hooks/composer/use-github-mention-search";
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
  const scope = useMemo<GithubMentionScope>(
    () => ({ epicId: currentEpicId, workspacePaths: mentionRoots }),
    [currentEpicId, mentionRoots],
  );
  const scopeKey = useMemo(
    () => githubMentionScopeKey(mentionRoots),
    [mentionRoots],
  );

  // The shared 60s clock, not `Date.now()`: every row's relative age in one
  // render agrees, the labels re-tick with the rest of the app, and reading it
  // during render stays pure.
  const now = useSampledNow();

  const pullRequestCatalog = useGithubMentionCatalog({
    client,
    scope,
    section: "pull-requests",
    enabled: active && (atRoot || openSection === "pull-requests"),
    allowStaleFollowUp: openSection === "pull-requests",
  });
  const issueCatalog = useGithubMentionCatalog({
    client,
    scope,
    section: "issues",
    enabled: active && (atRoot || openSection === "issues"),
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
  useEffect(() => {
    if (pullRequestCatalog.isPlaceholder) return;
    if (pullRequestCatalog.rows.length === 0) return;
    setRows({
      scopeKey,
      section: "pull-requests",
      rows: githubMentionRowsForSection(
        pullRequestCatalog.rows,
        "pull-requests",
      ),
    });
  }, [
    pullRequestCatalog.isPlaceholder,
    pullRequestCatalog.rows,
    scopeKey,
    setRows,
  ]);
  useEffect(() => {
    if (issueCatalog.isPlaceholder) return;
    if (issueCatalog.rows.length === 0) return;
    setRows({
      scopeKey,
      section: "issues",
      rows: githubMentionRowsForSection(issueCatalog.rows, "issues"),
    });
  }, [issueCatalog.isPlaceholder, issueCatalog.rows, scopeKey, setRows]);

  // The scope's repositories persist beside the rows because the two are read
  // together by a root-search row and must share ONE lifetime. The query
  // entries carry TanStack's default 5-minute `gcTime`; this store is
  // session-lived. Without this, reopening the menu past that window serves
  // rows from the warm store while the query answers `undefined`, and a
  // single-repo scope starts labelling its chips `repo#123`.
  useEffect(() => {
    const answered = pullRequestCatalog.scopeResolved
      ? pullRequestCatalog
      : issueCatalog;
    if (!answered.scopeResolved || answered.isPlaceholder) return;
    setRepositories({ scopeKey, repositories: answered.repositories });
  }, [issueCatalog, pullRequestCatalog, scopeKey, setRepositories]);

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
  // Live query answer first; the persisted one when neither query has answered
  // for this scope yet (a warm store outliving a garbage-collected query entry
  // is exactly the case that mislabels a chip at root).
  const queryRepositories = pullRequestCatalog.scopeResolved
    ? pullRequestCatalog.repositories
    : issueCatalog.repositories;
  const scopeResolved =
    pullRequestCatalog.scopeResolved || issueCatalog.scopeResolved;
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
  const openRows = useMemo<ReadonlyArray<GithubMentionRow>>(() => {
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
      now,
    }),
    [
      now,
      openRows,
      openSection,
      rootIssueRows,
      rootPullRequestRows,
      singleRepositoryScope,
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
  ]);

  return {
    context,
    chrome,
    loading:
      openSection !== null && openCatalog.isLoading && openRows.length === 0,
    // Core flows asks for the header spinner AND the `Checking…` stamp during a
    // background refetch, explicitly "same as Artifacts". Reporting one and not
    // the other would make this section quietly different from the one beside
    // it in the same menu.
    checking: openSection !== null && openCatalog.isChecking,
  };
}

function sectionContext(
  rows: ReadonlyArray<GithubMentionRow>,
  singleRepositoryScope: boolean,
): GithubMentionSectionContext {
  return { rows, singleRepositoryScope };
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
