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
  // A SHALLOW COPY per call, deliberately. The real hook builds its result
  // fresh on every render, so a mock that hands back one long-lived object
  // mutated in place would give the effects under test a stable identity
  // production never has - and an effect that depends on the whole catalog
  // object would look correct here while re-running every render in the app.
  useGithubMentionCatalog: (args: { readonly section: string }) => ({
    ...(args.section === "issues"
      ? catalogMocks.issues
      : catalogMocks.pullRequests),
  }),
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

// The scope key is now per (host, epic, folders), and the categories are gated
// on the host advertising both mention methods - so this suite has to name a
// host and say it supports them, or the effects under test never run at all.
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ hostId: "host-1" }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
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
const SCOPE_KEY = githubMentionScopeKey({
  hostId: "host-1",
  epicId: "epic-1",
  workspacePaths: ROOTS,
});
const ONE_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer-internal",
} as const;
/** Present in the older answer only: the repository a refresh saw leave. */
const DEPARTED_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "detached",
} as const;

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

  /**
   * An empty list from a host that HAS answered is as authoritative as any
   * other answer, and the store is session-lived. Skipping the write left the
   * previous non-empty result in place forever: the section itself looked
   * correctly empty (it reads the query), while root search kept offering PRs
   * that had been closed hours earlier.
   */
  it("clears stored rows when a resolved catalog answers with none", async () => {
    catalogMocks.pullRequests.rows = [pullRequest({ number: 1, title: "PR" })];
    catalogMocks.pullRequests.isPlaceholder = false;
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.repositories = [ONE_REPO];

    const first = renderSections("");
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      selectGithubMentionCatalogRows(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
        "pull-requests",
      ),
    ).toHaveLength(1);
    first.unmount();

    // The last open PR was closed; the next sweep resolves with nothing.
    catalogMocks.pullRequests.rows = [];
    renderSections("");
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionCatalogRows(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
        "pull-requests",
      ),
    ).toEqual([]);
  });

  /**
   * The other half of the same rule: `[]` because nothing has answered YET is
   * not an answer, and writing it would blank the warm store that is currently
   * the only thing serving root search.
   */
  it("leaves stored rows alone while the catalog has not answered", async () => {
    catalogMocks.pullRequests.rows = [pullRequest({ number: 1, title: "PR" })];
    catalogMocks.pullRequests.isPlaceholder = false;
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.repositories = [ONE_REPO];

    const first = renderSections("");
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    catalogMocks.pullRequests.rows = [];
    catalogMocks.pullRequests.scopeResolved = false;
    renderSections("");
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionCatalogRows(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
        "pull-requests",
      ),
    ).toHaveLength(1);
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

    // The published repositories are what chip labelling and the trailing
    // segment are derived from for root rows.
    expect(result.current.context.pullRequests.repositories).toEqual([
      ONE_REPO,
    ]);
    expect(result.current.context.issues.repositories).toEqual([ONE_REPO]);
  });

  it("records the more recently refreshed section's repositories at root", async () => {
    // Refresh Issues, which observes that a repository left the scope, then
    // press Back. At root there is no open section to prefer, and taking
    // pull-requests by POSITION writes its older answer straight back over the
    // store - reviving the departed repository for the reconciliation set and
    // the chip labelling until the disabled pull-request query refetches.
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.freshnessAt = 1_000;
    catalogMocks.pullRequests.repositories = [ONE_REPO, DEPARTED_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.freshnessAt = 2_000;
    catalogMocks.issues.repositories = [ONE_REPO];

    renderSections("");
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionScopeRepositories(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
      ),
    ).toEqual([ONE_REPO]);
  });

  it("still records the pull-request repositories at root when they are fresher", async () => {
    // The control: the fix orders the two answers, it does not swap which
    // section root reads. Reversing the preference would pass the case above
    // and fail this one.
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.freshnessAt = 2_000;
    catalogMocks.pullRequests.repositories = [ONE_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.freshnessAt = 1_000;
    catalogMocks.issues.repositories = [ONE_REPO, DEPARTED_REPO];

    renderSections("");
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionScopeRepositories(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
      ),
    ).toEqual([ONE_REPO]);
  });

  it("keeps the fresher answer when stepping into the staler section", async () => {
    // Refresh Pull requests, then open Issues straight after. The Issues query
    // is inside its 60s staleTime so it does not refetch, and preferring the
    // OPEN section outright wrote its older repositories back over the store -
    // the same regression as the root case, one navigation earlier.
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.freshnessAt = 2_000;
    catalogMocks.pullRequests.repositories = [ONE_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.freshnessAt = 1_000;
    catalogMocks.issues.repositories = [ONE_REPO, DEPARTED_REPO];

    renderIssuesSection();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionScopeRepositories(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
      ),
    ).toEqual([ONE_REPO]);
  });

  it("still believes the open section when it is the fresher answer", async () => {
    // The control: being open still wins the tie and wins when it is newer.
    // Only a strictly fresher other answer overrides it.
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.freshnessAt = 1_000;
    catalogMocks.pullRequests.repositories = [ONE_REPO, DEPARTED_REPO];
    catalogMocks.issues.scopeResolved = true;
    catalogMocks.issues.freshnessAt = 2_000;
    catalogMocks.issues.repositories = [ONE_REPO];

    renderIssuesSection();
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      selectGithubMentionScopeRepositories(
        useGithubMentionCatalogStore.getState(),
        SCOPE_KEY,
      ),
    ).toEqual([ONE_REPO]);
  });

  it("ranks root rows from the catalog on the render it resolves", () => {
    // The store is written by a passive effect, so on the resolving render it
    // still holds the previous answer. If the catalog was the last source to
    // settle, that same render also reads as settled - an authoritative
    // zero-match verdict over rows that had already arrived, and React does
    // not re-render between the publication effect and the dismissal one.
    catalogMocks.pullRequests.rows = [
      pullRequest({ number: 4917, title: "Stop the busy-loop" }),
    ];
    catalogMocks.pullRequests.scopeResolved = true;
    catalogMocks.pullRequests.repositories = [ONE_REPO];

    // Recorded DURING render rather than read off `result.current`:
    // `renderHook` is act-wrapped, so by the time it returns the publication
    // effect has already run and the store is populated - which is exactly the
    // render this test is not about. Only the first pass can show whether the
    // rows were available before that effect.
    const perRender: number[][] = [];
    renderHook(() => {
      const sections = useGithubMentionSections({
        client: fakeClient,
        active: true,
        step: ROOT_MENTION_STEP,
        currentEpicId: "epic-1",
        mentionRoots: ROOTS,
        query: "busy-loop",
        debouncedQuery: "busy-loop",
        limit: 20,
      });
      perRender.push(
        sections.context.pullRequests.rows.map((row) => row.number),
      );
      return sections;
    });

    expect(perRender[0]).toEqual([4917]);
  });
});
