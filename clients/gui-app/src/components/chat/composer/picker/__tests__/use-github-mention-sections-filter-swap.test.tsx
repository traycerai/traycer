import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import type { HostRpcRegistry } from "@/lib/host";
import type { MentionFlowStep } from "@/lib/composer/mentions/providers";
import { useGithubMentionFilterStore } from "@/stores/composer/github-mention-filter-store";

/**
 * Changing a funnel must not flash the section list away and back.
 *
 * The catalog only ever sweeps the DEFAULT view, so a filter it cannot answer
 * ("State: Merged" over a cache of open PRs) excludes every cached row the
 * instant it is selected, and the remote answer is a round trip away. Without
 * the hold, that window renders as an empty list - which is what made the
 * funnel read as "changing it does nothing".
 *
 * The catalog and search hooks are mocked at their boundary so the in-flight
 * window can be held open; everything under test (the local funnel, the merge,
 * the hold) is the real code.
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

const mocks = vi.hoisted(() => {
  const catalog = (): CatalogResult => ({
    rows: [],
    // A RESOLVED answer must name the repository its rows belong to - the
    // host derives both from the same sweep, and the sections hook now drops
    // rows the resolved set does not cover. `[]` here would be the
    // authoritative "these folders hold no GitHub repo".
    repositories: [
      { githubHost: "github.com", owner: "traycerai", repo: "traycer" },
    ],
    scopeResolved: true,
    freshnessAt: null,
    sourceStatus: "ok",
    notice: null,
    isLoading: false,
    isChecking: false,
    isPlaceholder: false,
    refreshManually: () => Promise.resolve(),
  });
  return {
    pullRequests: catalog(),
    issues: catalog(),
    search: {
      rows: [] as ReadonlyArray<GithubMentionRow>,
      isSearching: false,
    },
    reset() {
      Object.assign(this.pullRequests, catalog());
      Object.assign(this.issues, catalog());
      this.search.rows = [];
      this.search.isSearching = false;
    },
  };
});

vi.mock("@/hooks/composer/use-github-mention-catalog", () => ({
  // A shallow copy per call so the result identity churns the way the real
  // hook's does - but the `rows` array inside it must stay STABLE. A fresh
  // `[]` literal per render re-arms the row-publication effect, whose store
  // write re-renders, which mints another `[]`: an update loop authored
  // entirely by the harness.
  useGithubMentionCatalog: (args: { readonly section: string }) => ({
    ...(args.section === "issues" ? mocks.issues : mocks.pullRequests),
  }),
}));

vi.mock("@/hooks/composer/use-github-mention-search", () => ({
  useGithubMentionSearch: () => ({
    rows: mocks.search.rows,
    sourceStatus: null,
    notice: null,
    isSearching: mocks.search.isSearching,
    refresh: () => Promise.resolve(),
  }),
}));

vi.mock("@/lib/relative-time", () => ({ useSampledNow: () => 0 }));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1" }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

import { useGithubMentionSections } from "../use-github-mention-sections";

const REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer",
} as const;

function pullRequest(
  number: number,
  state: "open" | "merged" | "closed",
): GithubMentionRow {
  return {
    kind: "pull-request",
    ...REPO,
    number,
    title: `PR ${number}`,
    url: `https://github.com/traycerai/traycer/pull/${number}`,
    author: { login: "alice", avatarUrl: null },
    updatedAt: 1_000,
    buckets: ["recent"],
    state,
    isDraft: false,
    baseRefName: null,
    headRefName: null,
    reviewDecision: null,
    checksRollup: null,
  };
}

/** Same shape as `pullRequest`, but for an arbitrary repository. */
function pullRequestFromRepo(
  number: number,
  repo: {
    readonly githubHost: string;
    readonly owner: string;
    readonly repo: string;
  },
): GithubMentionRow {
  return {
    kind: "pull-request",
    ...repo,
    number,
    title: `PR ${number}`,
    url: `https://${repo.githubHost}/${repo.owner}/${repo.repo}/pull/${number}`,
    author: { login: "alice", avatarUrl: null },
    updatedAt: 1_000,
    buckets: ["recent"],
    state: "open",
    isDraft: false,
    baseRefName: null,
    headRefName: null,
    reviewDecision: null,
    checksRollup: null,
  };
}

const PR_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "pull-requests",
  stepId: "pull-requests",
  workspacePath: null,
};

function renderSections(query: string) {
  return renderHook(
    (props: { readonly query: string }) =>
      useGithubMentionSections({
        client: {} as HostClient<HostRpcRegistry>,
        active: true,
        step: PR_STEP,
        currentEpicId: "epic-1",
        mentionRoots: ["/repo"],
        query: props.query,
        debouncedQuery: props.query,
        limit: 20,
      }),
    { initialProps: { query } },
  );
}

/** Same hook, but with the mention scope as the varying prop. */
function renderSectionsForRoots(mentionRoots: ReadonlyArray<string>) {
  return renderHook(
    (props: { readonly mentionRoots: ReadonlyArray<string> }) =>
      useGithubMentionSections({
        client: {} as HostClient<HostRpcRegistry>,
        active: true,
        step: PR_STEP,
        currentEpicId: "epic-1",
        mentionRoots: props.mentionRoots,
        query: "",
        debouncedQuery: "",
        limit: 20,
      }),
    { initialProps: { mentionRoots } },
  );
}

function selectMergedState(): void {
  useGithubMentionFilterStore.getState().setFilter({
    epicId: "epic-1",
    section: "pull-requests",
    filter: { state: "merged", involvement: "everyone", repository: null },
  });
}

function prNumbers(rows: ReadonlyArray<GithubMentionRow>): number[] {
  return rows.map((row) => row.number);
}

beforeEach(() => {
  mocks.reset();
  useGithubMentionFilterStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  mocks.reset();
  useGithubMentionFilterStore.getState().resetForTests();
});

describe("useGithubMentionSections filter swap", () => {
  it("holds the rows on screen while the filter's search is in flight", () => {
    mocks.pullRequests.rows = [pullRequest(1, "open"), pullRequest(2, "open")];

    const { result, rerender } = renderSections("");
    expect(prNumbers(result.current.context.pullRequests.rows)).toEqual([1, 2]);

    // The funnel moves to a state the cache cannot answer, and the remote
    // search that CAN answer it has not come back yet.
    selectMergedState();
    mocks.search.isSearching = true;
    rerender({ query: "" });

    // Without the hold this is [] - the whole list replaced by a lone
    // "Searching GitHub…" row, then replaced again a moment later.
    expect(prNumbers(result.current.context.pullRequests.rows)).toEqual([1, 2]);
  });

  it("swaps to the remote answer once the search lands", () => {
    mocks.pullRequests.rows = [pullRequest(1, "open")];

    const { result, rerender } = renderSections("");
    selectMergedState();
    mocks.search.isSearching = true;
    rerender({ query: "" });

    mocks.search.rows = [pullRequest(7, "merged")];
    mocks.search.isSearching = false;
    rerender({ query: "" });

    expect(prNumbers(result.current.context.pullRequests.rows)).toEqual([7]);
  });

  it("reports a settled empty answer rather than holding stale rows forever", () => {
    mocks.pullRequests.rows = [pullRequest(1, "open")];

    const { result, rerender } = renderSections("");
    selectMergedState();
    mocks.search.isSearching = true;
    rerender({ query: "" });
    expect(prNumbers(result.current.context.pullRequests.rows)).toEqual([1]);

    // The remote answered: this repository genuinely has no merged PRs. A hold
    // that outlived the answer would claim otherwise, permanently.
    mocks.search.isSearching = false;
    rerender({ query: "" });

    expect(result.current.context.pullRequests.rows).toEqual([]);
  });

  it("does not answer a NEW query with the previous query's rows", () => {
    mocks.pullRequests.rows = [pullRequest(1, "open")];

    const { result, rerender } = renderSections("");
    expect(prNumbers(result.current.context.pullRequests.rows)).toEqual([1]);

    // Typing is a different question, not a different view of the same one -
    // holding here would show rows that visibly do not match what was typed.
    mocks.search.isSearching = true;
    rerender({ query: "nomatch" });

    expect(result.current.context.pullRequests.rows).toEqual([]);
  });

  it("does not hold rows across a mention-scope change", () => {
    mocks.pullRequests.rows = [pullRequest(1, "open")];

    const { result, rerender } = renderSectionsForRoots(["/repo"]);
    expect(prNumbers(result.current.context.pullRequests.rows)).toEqual([1]);

    // The composer's roots changed, so these rows belong to a scope the user
    // has left. Holding them through the replacement search is worse than a
    // brief empty list: every held row is selectable, and committing one
    // inserts a mention naming a repository this scope cannot resolve.
    mocks.pullRequests.rows = [];
    mocks.search.isSearching = true;
    rerender({ mentionRoots: ["/other-repo"] });

    expect(result.current.context.pullRequests.rows).toEqual([]);
  });

  it("reports rowsHeld true only while held rows are standing in, and false once the search answers", () => {
    mocks.pullRequests.rows = [pullRequest(1, "open"), pullRequest(2, "open")];

    const { result, rerender } = renderSections("");
    // Nothing is held yet - these are the live cached answer.
    expect(result.current.context.pullRequests.rowsHeld).toBe(false);

    // The funnel moves to a state the cache cannot answer, and the remote
    // search that CAN answer it has not come back yet - the previous
    // answer's rows are standing in, and `providers.tsx` reads this flag to
    // render them non-committable.
    selectMergedState();
    mocks.search.isSearching = true;
    rerender({ query: "" });
    expect(result.current.context.pullRequests.rowsHeld).toBe(true);

    // The search lands: the rows on screen are now the live answer again.
    mocks.search.rows = [pullRequest(7, "merged")];
    mocks.search.isSearching = false;
    rerender({ query: "" });
    expect(result.current.context.pullRequests.rowsHeld).toBe(false);
  });

  it("reports repositories as null when both catalogs are unresolved, even with rows from two repositories", () => {
    // Null is ignorance, not an authoritative empty scope: the live search
    // can put rows on screen before either catalog resolves. Qualifying them
    // against an empty `[]` would read as "these folders hold no GitHub
    // repo" when the truth is just "no answer yet" - collapsing two
    // DIFFERENT repositories' rows onto the same bare `#N` label, which is
    // the real defect this pins.
    mocks.pullRequests.scopeResolved = false;
    mocks.issues.scopeResolved = false;
    mocks.search.rows = [
      pullRequestFromRepo(1, REPO),
      pullRequestFromRepo(2, {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "traycer-internal",
      }),
    ];

    const { result } = renderSections("");

    expect(result.current.context.pullRequests.repositories).toBeNull();
  });
});
