import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";

import { githubMentionRowsForSection } from "@/lib/composer/mentions/github-mention-rows";
import {
  selectGithubMentionCatalogRows,
  selectGithubMentionScopeRepositories,
  useGithubMentionCatalogStore,
} from "@/stores/composer/github-mention-catalog-store";

/**
 * Session store for GitHub mention catalog rows + scope repositories.
 *
 * The write-path guards (`isPlaceholder`, section narrowing) live on the
 * effects in `use-github-mention-sections`; those are covered by the hook
 * suite that drives the real effects. This file pins the store surface those
 * effects write into — especially repositories sharing the rows' lifetime,
 * and reset clearing both maps so seeds cannot leak between tests.
 */

function pullRequest(
  overrides: Partial<Extract<GithubMentionRow, { kind: "pull-request" }>> &
    Pick<GithubMentionRow, "number" | "title">,
): Extract<GithubMentionRow, { kind: "pull-request" }> {
  return {
    kind: "pull-request",
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer",
    url: `https://github.com/traycerai/traycer/pull/${overrides.number}`,
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
    repo: "traycer",
    url: `https://github.com/traycerai/traycer/issues/${overrides.number}`,
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

const SCOPE = "/repo";
const ONE_REPO = {
  githubHost: "github.com",
  owner: "traycerai",
  repo: "traycer-internal",
} as const;

beforeEach(() => {
  useGithubMentionCatalogStore.getState().resetForTests();
});

afterEach(() => {
  useGithubMentionCatalogStore.getState().resetForTests();
});

describe("github-mention-catalog-store repositories", () => {
  it("persists repositories by scope and returns them when the query is cold", () => {
    useGithubMentionCatalogStore.getState().setRepositories({
      scopeKey: SCOPE,
      repositories: [ONE_REPO],
    });
    useGithubMentionCatalogStore.getState().setRows({
      scopeKey: SCOPE,
      section: "pull-requests",
      rows: [
        pullRequest({
          number: 4917,
          title: "Warm row",
          repo: "traycer-internal",
        }),
      ],
    });

    const state = useGithubMentionCatalogStore.getState();
    const persisted = selectGithubMentionScopeRepositories(state, SCOPE);
    expect(persisted).toEqual([ONE_REPO]);
    expect(persisted).toHaveLength(1);
  });

  it("returns empty repositories for an unknown scope", () => {
    expect(
      selectGithubMentionScopeRepositories(
        useGithubMentionCatalogStore.getState(),
        "other-scope",
      ),
    ).toEqual([]);
  });

  it("resetForTests clears repositoriesByScope as well as rows", () => {
    useGithubMentionCatalogStore.getState().setRepositories({
      scopeKey: SCOPE,
      repositories: [ONE_REPO],
    });
    useGithubMentionCatalogStore.getState().setRows({
      scopeKey: SCOPE,
      section: "issues",
      rows: [issue({ number: 1, title: "A" })],
    });

    useGithubMentionCatalogStore.getState().resetForTests();

    const state = useGithubMentionCatalogStore.getState();
    expect(state.repositoriesByScope).toEqual({});
    expect(state.rowsByKey).toEqual({});
    expect(selectGithubMentionScopeRepositories(state, SCOPE)).toEqual([]);
    expect(selectGithubMentionCatalogRows(state, SCOPE, "issues")).toEqual([]);
  });
});

describe("github-mention-catalog-store write-path composition", () => {
  /**
   * Thin pin: the effects write `githubMentionRowsForSection(...)` into
   * setRows, not the raw catalog array. Pure predicate coverage lives in
   * github-mention-rows.test.ts; this only shows a mixed seed through the
   * same composition the write path uses.
   */
  it("narrows mixed rows before setRows so only the section kind is stored", () => {
    const mixed = [
      pullRequest({ number: 1, title: "PR" }),
      issue({ number: 2, title: "Issue" }),
    ];

    useGithubMentionCatalogStore.getState().setRows({
      scopeKey: SCOPE,
      section: "pull-requests",
      rows: githubMentionRowsForSection(mixed, "pull-requests"),
    });

    const stored = selectGithubMentionCatalogRows(
      useGithubMentionCatalogStore.getState(),
      SCOPE,
      "pull-requests",
    );
    expect(stored.map((row) => row.kind)).toEqual(["pull-request"]);
    expect(stored).toHaveLength(1);
  });
});
