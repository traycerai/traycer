import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import type { HostRpcRegistry } from "@/lib/host";
import { githubMentionScopeKey } from "@/lib/composer/mentions/github-mention-rows";
import { ROOT_MENTION_STEP } from "@/lib/composer/mentions/providers";
import { useGithubMentionCatalogStore } from "@/stores/composer/github-mention-catalog-store";

/**
 * Rows must not outlive their repository's membership in the scope.
 *
 * The repository set is a property of the freshest RESOLVED answer, but two
 * carriers keep serving rows written under an OLDER resolution: the sibling
 * section's catalog entry inside its `staleTime`, and the session store. When
 * one section's refresh discovers a repository left the scope, the other
 * section used to keep showing - and inserting - that repository's references
 * until its own cache expired.
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
  sourceStatus: "ok" | "cached" | "gh-unavailable" | "error" | "partial";
  notice: null;
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
    sourceStatus: "cached",
    notice: null,
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
  // A shallow copy per call, same as the catalog-write suite: the real hook
  // builds its result fresh on every render.
  useGithubMentionCatalog: (args: { readonly section: string }) => ({
    ...(args.section === "issues"
      ? catalogMocks.issues
      : catalogMocks.pullRequests),
  }),
}));

vi.mock("@/hooks/composer/use-github-mention-search", () => {
  // ONE stable result object. The real hook's `rows` is identity-stable
  // across unrelated re-renders; a fresh array per render would break the
  // `localRows` memo every pass and turn the render-time held-rows adjuster
  // into an infinite loop - a harness artifact, not the production behaviour
  // under test.
  const result = {
    rows: [] as ReadonlyArray<GithubMentionRow>,
    sourceStatus: null,
    notice: null,
    isSearching: false,
  };
  return { useGithubMentionSearch: () => result };
});

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
const SCOPE_KEY = githubMentionScopeKey({
  hostId: "host-1",
  epicId: "epic-1",
  workspacePaths: ROOTS,
});
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
  return renderHook(() =>
    useGithubMentionSections({
      client: fakeClient,
      active: true,
      step: ISSUES_STEP,
      currentEpicId: "epic-1",
      mentionRoots: ROOTS,
      query: "",
      debouncedQuery: "",
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
}

/** The fresher answer: pull requests re-swept and saw the repo leave. */
function freshPullRequestsUnderNarrowScope(): void {
  catalogMocks.pullRequests.rows = [];
  catalogMocks.pullRequests.repositories = [KEPT_REPO];
  catalogMocks.pullRequests.scopeResolved = true;
  catalogMocks.pullRequests.freshnessAt = 2_000;
}

beforeEach(() => {
  catalogMocks.reset();
  useGithubMentionCatalogStore.getState().resetForTests();
});

afterEach(() => {
  catalogMocks.reset();
  useGithubMentionCatalogStore.getState().resetForTests();
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
    // The control: freshness decides the authority. When the wider answer IS
    // the freshest resolved one, its repositories are the scope, and nothing
    // may be filtered against a staler, narrower sibling.
    staleIssuesUnderWiderScope();
    freshPullRequestsUnderNarrowScope();
    catalogMocks.issues.freshnessAt = 3_000;

    const { result } = renderIssuesSection();

    const rows = result.current.context.issues.rows;
    expect(rows).toContainEqual(KEPT_ISSUE);
    expect(rows).toContainEqual(DEPARTED_ISSUE);
  });

  it("serves the warm store unfiltered while nothing has resolved", () => {
    // The cold-open guard: with no resolved answer there is no authority to
    // filter against, and blanking the store here would be a new defect.
    useGithubMentionCatalogStore.getState().setRows({
      scopeKey: SCOPE_KEY,
      section: "issues",
      rows: [KEPT_ISSUE, DEPARTED_ISSUE],
    });

    const { result } = renderRoot("fix");

    const rows = result.current.context.issues.rows;
    expect(rows).toContainEqual(KEPT_ISSUE);
    expect(rows).toContainEqual(DEPARTED_ISSUE);
  });
});
