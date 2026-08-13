import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import type { HostRpcRegistry } from "@/lib/host";
import { ROOT_MENTION_STEP } from "@/lib/composer/mentions/providers";

/**
 * Rows must not outlive their repository's membership in the scope.
 *
 * The repository set is a property of the freshest RESOLVED answer, but two
 * carriers still keep serving rows written under an OLDER resolution: the
 * sibling section's catalog entry inside its `staleTime`, and a held search
 * response predating the change. When one section's refresh discovers a
 * repository left the scope, the other carrier used to keep showing - and
 * inserting - that repository's references until its own cache expired.
 */

type CatalogResult = {
  rows: ReadonlyArray<GithubMentionRow>;
  repositories: ReadonlyArray<{
    githubHost: string;
    owner: string;
    repo: string;
  }>;
  scopeResolved: boolean;
  freshnessAt: number | null;
  /**
   * When THIS scope's answer reached the client (TanStack's `dataUpdatedAt`),
   * or null while unanswered. `preferredScopeAnswer` compares THIS field, not
   * `freshnessAt`, to decide which section's `repositories` a tie should
   * believe - see the scenarios below.
   */
  answeredAt: number | null;
  sourceStatus: "ok" | "cached" | "gh-unavailable" | "error" | "partial";
  notice: null;
  errored: boolean;
  isLoading: boolean;
  isChecking: boolean;
  isPlaceholder: boolean;
  refreshManually: () => Promise<void>;
};

const catalogMocks = vi.hoisted(() => {
  const empty = (): CatalogResult => ({
    rows: [],
    repositories: [],
    scopeResolved: false,
    freshnessAt: null,
    answeredAt: null,
    sourceStatus: "cached",
    notice: null,
    errored: false,
    isLoading: false,
    isChecking: false,
    isPlaceholder: false,
    refreshManually: () => Promise.resolve(),
  });
  return {
    pullRequests: empty(),
    issues: empty(),
    reset() {
      Object.assign(this.pullRequests, empty());
      Object.assign(this.issues, empty());
    },
  };
});

vi.mock("@/hooks/composer/use-github-mention-catalog", () => ({
  // A shallow copy per call, same as the production hook: it builds its
  // result fresh on every render.
  useGithubMentionCatalog: (args: { readonly section: string }) => ({
    ...(args.section === "issues"
      ? catalogMocks.issues
      : catalogMocks.pullRequests),
  }),
}));

type SearchMockState = {
  rows: ReadonlyArray<GithubMentionRow>;
  sourceStatus: null;
  notice: null;
  isSearching: boolean;
  errored: boolean;
  refresh: () => Promise<void>;
};

const searchMock = vi.hoisted(() => {
  const defaults = (): SearchMockState => ({
    rows: [],
    sourceStatus: null,
    notice: null,
    isSearching: false,
    errored: false,
    refresh: () => Promise.resolve(),
  });
  const state = defaults();
  return {
    state,
    reset(): void {
      Object.assign(this.state, defaults());
    },
  };
});

vi.mock("@/hooks/composer/use-github-mention-search", () => ({
  // ONE stable object, mutated in place rather than recreated. The real
  // hook's `rows` is identity-stable across unrelated re-renders; a fresh
  // array per render would break the `localRows` memo every pass and turn
  // the render-time held-rows adjuster into an infinite loop - a harness
  // artifact, not the production behaviour under test.
  useGithubMentionSearch: () => searchMock.state,
}));

vi.mock("@/lib/relative-time", () => ({
  useSampledNow: () => 0,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1" }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

import { useGithubMentionSections } from "../use-github-mention-sections";

function issue(
  overrides: Partial<Extract<GithubMentionRow, { kind: "issue" }>> &
    Pick<GithubMentionRow, "number" | "title" | "repo">,
): Extract<GithubMentionRow, { kind: "issue" }> {
  return {
    kind: "issue",
    githubHost: "github.com",
    owner: "traycerai",
    url: `https://github.com/traycerai/${overrides.repo}/issues/${overrides.number}`,
    author: { login: "bob", avatarUrl: null },
    updatedAt: 1_000,
    buckets: ["recent"],
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    ...overrides,
  };
}

const ROOTS = ["/repo"] as const;
const KEPT_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer-internal",
} as const;
/** In the older answer only: the repository a fresher refresh saw leave. */
const DEPARTED_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "detached",
} as const;

const KEPT_ISSUE = issue({
  number: 7,
  title: "Fix the parser",
  repo: KEPT_REPO.repo,
});
const DEPARTED_ISSUE = issue({
  number: 9,
  title: "Fix the lexer",
  repo: DEPARTED_REPO.repo,
});

const fakeClient = {} as HostClient<HostRpcRegistry>;

const ISSUES_STEP = {
  kind: "provider",
  providerId: "issues",
  stepId: "issues",
  workspacePath: null,
} as const;

function renderIssuesSection() {
  return renderIssuesSectionWithQuery({ query: "", debouncedQuery: "" });
}

function renderIssuesSectionWithQuery(input: {
  readonly query: string;
  readonly debouncedQuery: string;
}) {
  return renderHook(() =>
    useGithubMentionSections({
      client: fakeClient,
      active: true,
      step: ISSUES_STEP,
      currentEpicId: "epic-1",
      mentionRoots: ROOTS,
      query: input.query,
      debouncedQuery: input.debouncedQuery,
      limit: 20,
    }),
  );
}

function renderRoot(query: string) {
  return renderHook(() =>
    useGithubMentionSections({
      client: fakeClient,
      active: true,
      step: ROOT_MENTION_STEP,
      currentEpicId: "epic-1",
      mentionRoots: ROOTS,
      query,
      debouncedQuery: query,
      limit: 20,
    }),
  );
}

/** The stale sibling: issues answered earlier, under the wider repo set. */
function staleIssuesUnderWiderScope(): void {
  catalogMocks.issues.rows = [KEPT_ISSUE, DEPARTED_ISSUE];
  catalogMocks.issues.repositories = [KEPT_REPO, DEPARTED_REPO];
  catalogMocks.issues.scopeResolved = true;
  catalogMocks.issues.freshnessAt = 1_000;
  catalogMocks.issues.answeredAt = 1_000;
}

/** The fresher answer: pull requests re-swept and saw the repo leave. */
function freshPullRequestsUnderNarrowScope(): void {
  catalogMocks.pullRequests.rows = [];
  catalogMocks.pullRequests.repositories = [KEPT_REPO];
  catalogMocks.pullRequests.scopeResolved = true;
  catalogMocks.pullRequests.freshnessAt = 2_000;
  catalogMocks.pullRequests.answeredAt = 2_000;
}

beforeEach(() => {
  catalogMocks.reset();
  searchMock.reset();
});

afterEach(() => {
  catalogMocks.reset();
  searchMock.reset();
});

describe("useGithubMentionSections repository scope boundary", () => {
  it("drops the departed repository's rows from the stale sibling section", () => {
    staleIssuesUnderWiderScope();
    freshPullRequestsUnderNarrowScope();

    const { result } = renderIssuesSection();

    const rows = result.current.context.issues.rows;
    expect(rows).toContainEqual(KEPT_ISSUE);
    expect(rows).not.toContainEqual(DEPARTED_ISSUE);
  });

  it("drops the departed repository's rows at root too", () => {
    // Root reaches insertable rows without passing through the open section's
    // merge, so the boundary must hold on that path as well.
    staleIssuesUnderWiderScope();
    freshPullRequestsUnderNarrowScope();

    const { result } = renderRoot("fix");

    const rows = result.current.context.issues.rows;
    expect(rows).toContainEqual(KEPT_ISSUE);
    expect(rows).not.toContainEqual(DEPARTED_ISSUE);
  });

  it("keeps every row when the open section's own answer is the freshest", () => {
    // The control: arrival recency decides the authority. When the wider
    // answer is the one that reached the client MOST RECENTLY, its
    // repositories are the scope, and nothing may be filtered against a
    // staler, narrower sibling.
    staleIssuesUnderWiderScope();
    freshPullRequestsUnderNarrowScope();
    catalogMocks.issues.freshnessAt = 3_000;
    catalogMocks.issues.answeredAt = 3_000;

    const { result } = renderIssuesSection();

    const rows = result.current.context.issues.rows;
    expect(rows).toContainEqual(KEPT_ISSUE);
    expect(rows).toContainEqual(DEPARTED_ISSUE);
  });

  it("prefers the open section's own answer when it arrived more recently, even if the sibling's last successful GitHub reach is newer", () => {
    // The degraded-sweep case: a sweep can re-resolve `repositories` without a
    // successful GitHub reach, so it advances `answeredAt` (when the answer
    // reached the client) without advancing `freshnessAt` (the host's last
    // successful reach). Here the SIBLING has the newer `freshnessAt` but the
    // OLDER `answeredAt` - `preferredScopeAnswer` must compare arrival time,
    // not freshness, or the open section's own degraded-but-recent
    // resolution would lose to a sibling answer that is stale on the clock
    // that actually decides the tie.
    catalogMocks.issues.repositories = [KEPT_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.freshnessAt = 500;
    catalogMocks.issues.answeredAt = 4_000;

    catalogMocks.pullRequests.repositories = [DEPARTED_REPO];
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.freshnessAt = 5_000;
    catalogMocks.pullRequests.answeredAt = 1_000;

    const { result } = renderIssuesSection();

    expect(result.current.context.issues.repositories).toEqual([KEPT_REPO]);
  });

  it("falls back to the sibling's repositories when IT answered more recently, even with an older freshnessAt", () => {
    // The control for the case above: swap which side has the newer
    // `answeredAt` and confirm the sibling wins instead - proving the
    // assertion above is actually reading `answeredAt`, not a fixed
    // "the open section always wins" shortcut.
    catalogMocks.issues.repositories = [KEPT_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.freshnessAt = 5_000;
    catalogMocks.issues.answeredAt = 1_000;

    catalogMocks.pullRequests.repositories = [DEPARTED_REPO];
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.freshnessAt = 500;
    catalogMocks.pullRequests.answeredAt = 4_000;

    const { result } = renderIssuesSection();

    expect(result.current.context.issues.repositories).toEqual([DEPARTED_REPO]);
  });

  it("surfaces a failed catalog read through the result", () => {
    // The wiring the dismissal verdict depends on: a mocked-away catalog that
    // errored must reach `result.errored`, or a failed GitHub source reads as
    // "settled and empty" at root and the picker dismisses over it.
    catalogMocks.issues.errored = true;

    const { result } = renderRoot("fix");

    expect(result.current.errored).toBe(true);
  });

  it("surfaces a failed live search through the result", () => {
    // The other lane `errored` folds in: the OPEN section's live search. A
    // rejected search carries no rows, so without this a failed remote search
    // reads exactly like "settled, no extra hits", and the zero-match verdict
    // closes the picker over hits the request never returned.
    Object.assign(searchMock.state, { errored: true });

    const { result } = renderIssuesSection();

    expect(result.current.errored).toBe(true);
  });

  it("reports no error when both catalogs are healthy", () => {
    const { result } = renderRoot("fix");

    expect(result.current.errored).toBe(false);
  });

  it("projects the debounce gap as searching, not as a settled answer", () => {
    // `query` filters the visible rows immediately; the search still holds
    // the previous debouncedQuery for up to 250ms. Reporting that window as
    // settled rendered the authoritative "No matching…" before the remote
    // request had even started.
    staleIssuesUnderWiderScope();

    const { result } = renderIssuesSectionWithQuery({
      query: "fix",
      debouncedQuery: "",
    });

    expect(result.current.chrome?.appendedStatus).not.toBeNull();
  });

  it("does not claim searching once the debounce has flushed", () => {
    // The control: with query and debouncedQuery agreeing and no search in
    // flight, the section's answer really is settled.
    staleIssuesUnderWiderScope();

    const { result } = renderIssuesSectionWithQuery({
      query: "fix",
      debouncedQuery: "fix",
    });

    expect(result.current.chrome?.appendedStatus).toBeNull();
  });

  it("hides root hydration behind an empty query", () => {
    // Root's category list is complete without a query; the cache-only
    // hydration reads must not put up a Loading row and header spinner for
    // work that cannot change what is on screen.
    catalogMocks.pullRequests.isLoading = true;
    catalogMocks.pullRequests.isChecking = true;

    const { result } = renderRoot("");

    expect(result.current.loading).toBe(false);
    expect(result.current.checking).toBe(false);
  });

  it("reports root hydration once a query needs it", () => {
    // The control: a typed root query is answered from these reads, so their
    // pending state gates the zero-match dismissal and the Loading row.
    catalogMocks.pullRequests.isLoading = true;

    const { result } = renderRoot("fix");

    expect(result.current.loading).toBe(true);
  });

  it("withholds root rows while nothing has resolved", () => {
    // The cold-open case: with neither catalog resolved there is no
    // authority to serve rows from - root rows must be empty rather than
    // some carrier filling the gap with a stale answer.
    const { result } = renderRoot("fix");

    expect(result.current.context.issues.rows).toEqual([]);
  });

  it("does not serve another scope's placeholder at root", () => {
    // `isPlaceholder` marks the PREVIOUS scope's answer, held on screen by
    // `keepPreviousData` while the current scope's read lands. Root offers
    // rows as insertable mentions, so serving a placeholder there would offer
    // a repository this scope has not actually resolved.
    catalogMocks.issues.rows = [KEPT_ISSUE];
    catalogMocks.issues.repositories = [KEPT_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.isPlaceholder = true;

    const { result } = renderRoot("fix");

    expect(result.current.context.issues.rows).toEqual([]);
  });

  it("ranks root rows from the catalog on the render they resolve", () => {
    // Root rows are a plain `useMemo` off the catalog's own props, with no
    // publishing effect sitting between a resolving render and these rows -
    // so the FIRST render already carries them. Recorded per render, not off
    // `result.current`: `renderHook` is act-wrapped, so by the time it
    // returns any such effect would already have run, which is exactly the
    // gap this guards against a future regression reopening.
    catalogMocks.issues.rows = [KEPT_ISSUE];
    catalogMocks.issues.repositories = [KEPT_REPO];
    catalogMocks.issues.scopeResolved = true;

    const perRender: number[][] = [];
    renderHook(() => {
      const sections = useGithubMentionSections({
        client: fakeClient,
        active: true,
        step: ROOT_MENTION_STEP,
        currentEpicId: "epic-1",
        mentionRoots: ROOTS,
        query: "fix",
        debouncedQuery: "fix",
        limit: 20,
      });
      perRender.push(sections.context.issues.rows.map((row) => row.number));
      return sections;
    });

    expect(perRender[0]).toEqual([7]);
  });
});
