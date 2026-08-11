import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";

import type { HostRpcRegistry } from "@/lib/host";
import { githubMentionScopeKey } from "@/lib/composer/mentions/github-mention-rows";
import { ROOT_MENTION_STEP } from "@/lib/composer/mentions/providers";
import {
  selectGithubMentionCatalogRows,
  selectGithubMentionScopeRepositories,
  useGithubMentionCatalogStore,
} from "@/stores/composer/github-mention-catalog-store";

/**
 * Drives the real setRows / setRepositories effects in
 * `useGithubMentionSections` with catalog hooks mocked at their boundary.
 * That is the only way the production guards (isPlaceholder, section
 * narrowing, cold-query repository fallback) can go red when reverted.
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
  useGithubMentionCatalog: (args: { readonly section: string }) =>
    args.section === "issues" ? catalogMocks.issues : catalogMocks.pullRequests,
}));

vi.mock("@/hooks/composer/use-github-mention-search", () => ({
  useGithubMentionSearch: () => ({
    rows: [],
    sourceStatus: null,
    notice: null,
    isSearching: false,
  }),
}));

vi.mock("@/lib/relative-time", () => ({
  useSampledNow: () => 0,
}));

import { useGithubMentionSections } from "../use-github-mention-sections";

function pullRequest(
  overrides: Partial<Extract<GithubMentionRow, { kind: "pull-request" }>> &
    Pick<GithubMentionRow, "number" | "title">,
): Extract<GithubMentionRow, { kind: "pull-request" }> {
  return {
    kind: "pull-request",
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer-internal",
    url: `https://github.com/traycerai/traycer-internal/pull/${overrides.number}`,
    author: { login: "alice", avatarUrl: null },
    updatedAt: 1_000,
    buckets: ["recent"],
    state: "open",
    isDraft: false,
    baseRefName: null,
    headRefName: null,
    reviewDecision: null,
    checksRollup: null,
    ...overrides,
  };
}

function issue(
  overrides: Partial<Extract<GithubMentionRow, { kind: "issue" }>> &
    Pick<GithubMentionRow, "number" | "title">,
): Extract<GithubMentionRow, { kind: "issue" }> {
  return {
    kind: "issue",
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer-internal",
    url: `https://github.com/traycerai/traycer-internal/issues/${overrides.number}`,
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
const SCOPE_KEY = githubMentionScopeKey(ROOTS);
const ONE_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer-internal",
} as const;

const fakeClient = {} as HostClient<HostRpcRegistry>;

function renderSections(query: string) {
  return renderHook(
    (props: { readonly query: string }) =>
      useGithubMentionSections({
        client: fakeClient,
        active: true,
        step: ROOT_MENTION_STEP,
        currentEpicId: "epic-1",
        mentionRoots: ROOTS,
        query: props.query,
        debouncedQuery: props.query,
        limit: 20,
      }),
    { initialProps: { query } },
  );
}

beforeEach(() => {
  catalogMocks.reset();
  useGithubMentionCatalogStore.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  catalogMocks.reset();
  useGithubMentionCatalogStore.getState().resetForTests();
});

describe("useGithubMentionSections catalog write path", () => {
  it("does not record placeholder catalog rows into the session store", async () => {
    const realRows = [pullRequest({ number: 10, title: "Real" })];
    catalogMocks.pullRequests.rows = realRows;
    catalogMocks.pullRequests.isPlaceholder = false;
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.repositories = [ONE_REPO];

    const { rerender } = renderSections("");
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionCatalogRows(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
        "pull-requests",
      ),
    ).toEqual(realRows);

    // A later scope (or the same key under keepPreviousData) surfaces the
    // previous answer as a placeholder. Recording it would pin foreign rows
    // under this scopeKey past the placeholder window.
    const placeholderRows = [
      pullRequest({ number: 99, title: "Placeholder from prior scope" }),
    ];
    catalogMocks.pullRequests.rows = placeholderRows;
    catalogMocks.pullRequests.isPlaceholder = true;

    rerender({ query: "" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionCatalogRows(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
        "pull-requests",
      ),
    ).toEqual(realRows);
    expect(
      selectGithubMentionCatalogRows(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
        "pull-requests",
      ).map((row) => row.number),
    ).not.toContain(99);
  });

  it("records non-placeholder rows and narrows them to the section kind", async () => {
    const mixed: ReadonlyArray<GithubMentionRow> = [
      pullRequest({ number: 1, title: "PR" }),
      issue({ number: 2, title: "Leaked issue" }),
      pullRequest({ number: 3, title: "PR two" }),
    ];
    catalogMocks.pullRequests.rows = mixed;
    catalogMocks.pullRequests.isPlaceholder = false;
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.repositories = [ONE_REPO];

    renderSections("");
    await act(async () => {
      await Promise.resolve();
    });

    const stored = selectGithubMentionCatalogRows(
      useGithubMentionCatalogStore.getState(),
      SCOPE_KEY,
      "pull-requests",
    );
    expect(stored.map((row) => row.kind)).toEqual([
      "pull-request",
      "pull-request",
    ]);
    expect(stored.map((row) => row.number)).toEqual([1, 3]);
  });

  it("falls back to persisted repositories when the query has not answered (warm store, cold query)", async () => {
    // Real-world: menu opened, catalog answered, closed, TanStack gc'd the
    // query entry; root search still has session-store rows. Without the
    // fallback, scopeRepositories is [] and a single-repo scope labels chips
    // `traycer-internal#4917` instead of `#4917`.
    useGithubMentionCatalogStore.getState().setRepositories({
      scopeKey: SCOPE_KEY,
      repositories: [ONE_REPO],
    });
    useGithubMentionCatalogStore.getState().setRows({
      scopeKey: SCOPE_KEY,
      section: "pull-requests",
      rows: [pullRequest({ number: 4917, title: "Warm" })],
    });

    // Both catalog observers cold: no answer yet.
    catalogMocks.pullRequests.scopeResolved = false;
    catalogMocks.pullRequests.repositories = [];
    catalogMocks.issues.scopeResolved = false;
    catalogMocks.issues.repositories = [];

    const { result } = renderSections("4917");
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionScopeRepositories(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
      ),
    ).toEqual([ONE_REPO]);

    // singleRepositoryScope feeds chip labelling for root rows.
    expect(result.current.context.pullRequests.singleRepositoryScope).toBe(
      true,
    );
    expect(result.current.context.issues.singleRepositoryScope).toBe(true);
  });
});
