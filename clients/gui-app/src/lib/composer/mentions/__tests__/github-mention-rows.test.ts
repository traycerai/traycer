import { describe, expect, it } from "vitest";
import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";

import {
  asIssueMentionFilter,
  asPullRequestMentionFilter,
  DEFAULT_ISSUE_MENTION_FILTER,
  DEFAULT_PULL_REQUEST_MENTION_FILTER,
  filterGithubMentionRows,
  githubMentionBucketRank,
  githubMentionMatchScore,
  githubMentionRowKey,
  githubMentionScopeKey,
  githubMentionRowsForSection,
  mergeGithubMentionRows,
  parseGithubReferenceQuery,
  rankGithubMentionRows,
} from "../github-mention-rows";

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
    // Present-and-nullable, never absent. The wire schema requires all four;
    // making them optional here compiles as `T | undefined` and only fails at
    // `bun run compile`, which vitest never runs - a green suite proves
    // nothing about this.
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

describe("githubMentionRowsForSection", () => {
  it("keeps only issues when section is issues", () => {
    const issueRow = issue({ number: 10, title: "Issue" });
    const prRow = pullRequest({ number: 4917, title: "PR" });
    const mixed = [
      prRow,
      issueRow,
      pullRequest({ number: 12, title: "Other PR" }),
    ];

    const filtered = githubMentionRowsForSection(mixed, "issues");

    expect(filtered.map((row) => row.kind)).toEqual(["issue"]);
    expect(filtered).toEqual([issueRow]);
  });

  it("keeps only pull requests when section is pull-requests", () => {
    const issueRow = issue({ number: 10, title: "Issue" });
    const prRow = pullRequest({ number: 4917, title: "PR" });
    const mixed = [
      issueRow,
      prRow,
      issue({ number: 11, title: "Other issue" }),
    ];

    const filtered = githubMentionRowsForSection(mixed, "pull-requests");

    expect(filtered.map((row) => row.kind)).toEqual(["pull-request"]);
    expect(filtered).toEqual([prRow]);
  });

  it("returns the same array reference when every row already belongs to the section", () => {
    const issuesOnly = [
      issue({ number: 1, title: "A" }),
      issue({ number: 2, title: "B" }),
    ];
    const prsOnly = [
      pullRequest({ number: 3, title: "C" }),
      pullRequest({ number: 4, title: "D" }),
    ];

    expect(githubMentionRowsForSection(issuesOnly, "issues")).toBe(issuesOnly);
    expect(githubMentionRowsForSection(prsOnly, "pull-requests")).toBe(prsOnly);
  });

  it("returns empty for empty input", () => {
    expect(githubMentionRowsForSection([], "issues")).toEqual([]);
    expect(githubMentionRowsForSection([], "pull-requests")).toEqual([]);
  });

  it("returns empty when every row is the wrong kind for the section", () => {
    const onlyPrs = [
      pullRequest({ number: 1, title: "A" }),
      pullRequest({ number: 2, title: "B" }),
    ];
    const onlyIssues = [
      issue({ number: 3, title: "C" }),
      issue({ number: 4, title: "D" }),
    ];

    expect(githubMentionRowsForSection(onlyPrs, "issues")).toEqual([]);
    expect(githubMentionRowsForSection(onlyIssues, "pull-requests")).toEqual(
      [],
    );
  });

  /**
   * Same composition the open section uses in `use-github-mention-sections`
   * (`openRows`): both catalog and search are narrowed BEFORE merge. A
   * keepPreviousData leak hands the Issues section PR rows on the search arm;
   * without the search-side filter those PRs survive into the list and can
   * insert a `github_pull_request` chip from Issues.
   */
  it("merge seam: both inputs narrowed the way openRows does so a PR cannot leak into issues", () => {
    const cachedIssue = issue({
      number: 100,
      title: "Cached issue",
      buckets: ["recent"],
    });
    // Previous section's search payload still in flight via keepPreviousData.
    const leakedPr = pullRequest({
      number: 4917,
      title: "Leaked PR from prior search key",
      buckets: ["search"],
    });
    const searchOnlyIssue = issue({
      number: 200,
      title: "Remote issue hit",
      buckets: ["search"],
    });
    const cached = [cachedIssue];
    const searchRows = [leakedPr, searchOnlyIssue];

    // Identical to openRows: filter both arms, then merge.
    const merged = mergeGithubMentionRows(
      githubMentionRowsForSection(cached, "issues"),
      githubMentionRowsForSection(searchRows, "issues"),
    );

    expect(merged.map((row) => row.kind)).toEqual(["issue", "issue"]);
    expect(merged.map((row) => row.number)).toEqual([100, 200]);
    expect(merged.some((row) => row.kind === "pull-request")).toBe(false);

    // If only the catalog arm is filtered (the easy half to keep), the PR
    // still lands. The composition must filter search too.
    const catalogOnly = mergeGithubMentionRows(
      githubMentionRowsForSection(cached, "issues"),
      searchRows,
    );
    expect(catalogOnly.some((row) => row.kind === "pull-request")).toBe(true);
  });
});

describe("mergeGithubMentionRows", () => {
  it("keeps the cached row's position but takes the remote hit's payload", () => {
    const cached = pullRequest({
      number: 4917,
      title: "Stop the busy-loop",
      buckets: ["epic"],
      updatedAt: 5_000,
    });
    const remoteTwin = pullRequest({
      number: 4917,
      title: "Stop the busy-loop (remote title)",
      buckets: ["search"],
      updatedAt: 9_000,
    });
    const remoteOnly = pullRequest({
      number: 4920,
      title: "Remote-only hit",
      buckets: ["search"],
    });

    const merged = mergeGithubMentionRows([cached], [remoteTwin, remoteOnly]);

    expect(merged).toHaveLength(2);
    // Position and key are the cached row's - that is what keeps the
    // highlight still while the user types.
    expect(githubMentionRowKey(merged[0])).toBe(githubMentionRowKey(cached));
    // The payload is the fresh one. Keeping the cached copy discarded the very
    // state the search was issued to discover.
    expect(merged[0]).toBe(remoteTwin);
    expect(merged[0].title).toBe("Stop the busy-loop (remote title)");
    expect(merged[1]).toBe(remoteOnly);
  });

  // The failure this guards is silent and looks like "search found nothing":
  // a state-filtered search returns a row the sweep still records as `open`,
  // the stale copy wins the merge, and the filter downstream then drops it.
  it("lets a state-filtered search survive its own merge against a stale cache", () => {
    const staleOpen = pullRequest({
      number: 77,
      title: "Landed while the cache was warm",
      state: "open",
      buckets: ["authored"],
    });
    const freshMerged = pullRequest({
      number: 77,
      title: "Landed while the cache was warm",
      state: "merged",
      buckets: ["search"],
    });

    const merged = mergeGithubMentionRows([staleOpen], [freshMerged]);
    const visible = filterGithubMentionRows(merged, "pull-requests", {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      state: "merged",
    });

    expect(visible).toEqual([freshMerged]);
  });

  it("does not treat the same owner/repo/number on a different host as a duplicate", () => {
    const githubCom = pullRequest({
      number: 100,
      title: "Public",
      githubHost: "github.com",
    });
    const ghes = pullRequest({
      number: 100,
      title: "Enterprise",
      githubHost: "github.enterprise.example",
    });

    const merged = mergeGithubMentionRows([githubCom], [ghes]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(githubCom);
    expect(merged[1]).toBe(ghes);
  });

  it("deduplicates within the remote list itself, keeping the first remote occurrence", () => {
    const firstRemote = pullRequest({
      number: 50,
      title: "First remote",
      buckets: ["search"],
    });
    const secondRemote = pullRequest({
      number: 50,
      title: "Second remote twin",
      buckets: ["search"],
    });
    const uniqueRemote = pullRequest({
      number: 51,
      title: "Unique",
      buckets: ["search"],
    });

    const merged = mergeGithubMentionRows(
      [],
      [firstRemote, secondRemote, uniqueRemote],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(firstRemote);
    expect(merged[1]).toBe(uniqueRemote);
  });

  it("returns the cached array reference when remote adds nothing and changes nothing", () => {
    const only = pullRequest({ number: 1, title: "Only" });
    const cached = [only];

    // The host re-answered with a row the cache already holds. Nothing to
    // append and nothing to refresh, so the list must not churn identity -
    // that churn is what re-keys the picker mid-typing.
    const merged = mergeGithubMentionRows(cached, [only]);
    expect(merged).toBe(cached);
  });

  it("allocates a new list when a remote twin actually changes the payload", () => {
    const cached = [pullRequest({ number: 1, title: "Only" })];
    const remoteTwin = pullRequest({ number: 1, title: "Twin" });

    const merged = mergeGithubMentionRows(cached, [remoteTwin]);
    expect(merged).not.toBe(cached);
    expect(merged).toEqual([remoteTwin]);
  });

  it("returns cached when remote is empty", () => {
    const cached = [pullRequest({ number: 1, title: "Only" })];
    expect(mergeGithubMentionRows(cached, [])).toBe(cached);
  });
});

describe("parseGithubReferenceQuery", () => {
  it("recognizes a bare #number reference", () => {
    expect(parseGithubReferenceQuery("#123")).toEqual({
      kind: "number",
      number: 123,
    });
  });

  it("recognizes org/repo#number", () => {
    expect(parseGithubReferenceQuery("org/repo#123")).toEqual({
      kind: "repository",
      owner: "org",
      repo: "repo",
      number: 123,
    });
  });

  it("recognizes a pull request URL and returns the section", () => {
    expect(
      parseGithubReferenceQuery("https://github.com/org/repo/pull/123"),
    ).toEqual({
      kind: "url",
      githubHost: "github.com",
      owner: "org",
      repo: "repo",
      number: 123,
      section: "pull-requests",
    });
  });

  it("recognizes an issues URL and returns the section", () => {
    expect(
      parseGithubReferenceQuery("https://github.com/org/repo/issues/45"),
    ).toEqual({
      kind: "url",
      githubHost: "github.com",
      owner: "org",
      repo: "repo",
      number: 45,
      section: "issues",
    });
  });

  it("rejects non-references", () => {
    expect(parseGithubReferenceQuery("#")).toBeNull();
    expect(parseGithubReferenceQuery("#abc")).toBeNull();
    // Eight digits exceeds the 1–7 digit reference window.
    expect(parseGithubReferenceQuery("12345678")).toBeNull();
    expect(parseGithubReferenceQuery("#12345678")).toBeNull();
    expect(parseGithubReferenceQuery("fix the busy loop")).toBeNull();
    expect(parseGithubReferenceQuery("org/repo")).toBeNull();
    expect(parseGithubReferenceQuery("")).toBeNull();
    expect(parseGithubReferenceQuery("   ")).toBeNull();
  });
});

describe("githubMentionMatchScore", () => {
  it("scores an exact number match better than a title that merely contains the digits", () => {
    const numbered = pullRequest({
      number: 4917,
      title: "Unrelated title without digits as intent",
    });
    const titleHit = pullRequest({
      number: 12,
      title: "Mentions 4917 in the title only",
    });

    const numberScore = githubMentionMatchScore(numbered, "4917");
    const titleScore = githubMentionMatchScore(titleHit, "4917");

    expect(numberScore).toBe(0);
    expect(titleScore).not.toBeNull();
    if (numberScore === null || titleScore === null) {
      throw new Error("expected both rows to match");
    }
    expect(numberScore).toBeLessThan(titleScore);
  });

  it("treats a bare #number query as an exact number match", () => {
    const row = pullRequest({ number: 812, title: "Magic link" });
    expect(githubMentionMatchScore(row, "#812")).toBe(0);
  });
});

describe("filterGithubMentionRows", () => {
  const rows: ReadonlyArray<GithubMentionRow> = [
    pullRequest({
      number: 1,
      title: "Epic PR",
      buckets: ["epic", "recent"],
      state: "open",
      owner: "traycerai",
      repo: "traycer",
    }),
    pullRequest({
      number: 2,
      title: "Review requested",
      buckets: ["review-requested"],
      state: "open",
      owner: "traycerai",
      repo: "traycer-internal",
    }),
    pullRequest({
      number: 3,
      title: "Authored merged",
      buckets: ["authored"],
      state: "merged",
      owner: "other",
      repo: "elsewhere",
      githubHost: "github.com",
    }),
    issue({
      number: 10,
      title: "Assigned issue",
      buckets: ["assigned"],
      state: "open",
    }),
    issue({
      number: 11,
      title: "Mentions me closed",
      buckets: ["mentions"],
      state: "closed",
    }),
  ];

  it("answers involvement from row.buckets", () => {
    const filtered = filterGithubMentionRows(rows, "pull-requests", {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      involvement: "review-requested",
    });
    expect(filtered.map((row) => row.number)).toEqual([2]);
  });

  it("never narrows when involvement is everyone", () => {
    const filtered = filterGithubMentionRows(
      rows,
      "pull-requests",
      DEFAULT_PULL_REQUEST_MENTION_FILTER,
    );
    // Default state is open, so merged/closed rows still drop out of state.
    expect(filtered.map((row) => row.number).toSorted((a, b) => a - b)).toEqual(
      [1, 2, 10],
    );
  });

  it("never narrows when state is all", () => {
    const filtered = filterGithubMentionRows(rows, "pull-requests", {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      state: "all",
    });
    expect(filtered.map((row) => row.number).toSorted((a, b) => a - b)).toEqual(
      [1, 2, 3, 10, 11],
    );
  });

  it("narrows repository by host, owner, and repo together", () => {
    const filtered = filterGithubMentionRows(rows, "pull-requests", {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      state: "all",
      repository: {
        githubHost: "github.com",
        owner: "traycerai",
        repo: "traycer-internal",
      },
    });
    expect(filtered.map((row) => row.number)).toEqual([2]);
  });

  it("does not match a repo when only owner/repo align but host differs", () => {
    const filtered = filterGithubMentionRows(
      [
        pullRequest({
          number: 99,
          title: "GHES twin",
          githubHost: "github.enterprise.example",
          owner: "traycerai",
          repo: "traycer",
          state: "open",
        }),
      ],
      "pull-requests",
      {
        ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
        repository: {
          githubHost: "github.com",
          owner: "traycerai",
          repo: "traycer",
        },
      },
    );
    expect(filtered).toEqual([]);
  });

  it("filters issues by involvement bucket including mentions", () => {
    const filtered = filterGithubMentionRows(rows, "issues", {
      ...DEFAULT_ISSUE_MENTION_FILTER,
      state: "all",
      involvement: "mentions",
    });
    expect(filtered.map((row) => row.number)).toEqual([11]);
  });
});

describe("rankGithubMentionRows", () => {
  it("orders empty-query lists by bucket then recency", () => {
    const epicOlder = pullRequest({
      number: 1,
      title: "Epic older",
      buckets: ["epic"],
      updatedAt: 100,
    });
    const epicNewer = pullRequest({
      number: 2,
      title: "Epic newer",
      buckets: ["epic"],
      updatedAt: 300,
    });
    const reviewRequested = pullRequest({
      number: 3,
      title: "Review",
      buckets: ["review-requested"],
      updatedAt: 9_000,
    });
    const recent = pullRequest({
      number: 4,
      title: "Recent only",
      buckets: ["recent"],
      updatedAt: 50_000,
    });

    const ranked = rankGithubMentionRows({
      rows: [recent, reviewRequested, epicOlder, epicNewer],
      section: "pull-requests",
      query: "",
      limit: 10,
    });

    expect(ranked.map((row) => row.number)).toEqual([2, 1, 3, 4]);
  });

  it("lets match strength lead when a query is present; bucket only ties", () => {
    const titleMatchEpic = pullRequest({
      number: 10,
      title: "relay telemetry",
      buckets: ["epic"],
      updatedAt: 100,
    });
    const exactNumberRecent = pullRequest({
      number: 4917,
      title: "Unrelated",
      buckets: ["recent"],
      updatedAt: 50,
    });

    const ranked = rankGithubMentionRows({
      rows: [titleMatchEpic, exactNumberRecent],
      section: "pull-requests",
      query: "4917",
      limit: 10,
    });

    // Exact number (score 0) outranks a weaker title/subsequence match even
    // when the latter sits in a better involvement bucket.
    expect(ranked[0]).toBe(exactNumberRecent);
  });

  it("uses bucket as the tiebreak when match scores are equal", () => {
    const epic = pullRequest({
      number: 1,
      title: "stop the loop",
      buckets: ["epic"],
      updatedAt: 100,
    });
    const recent = pullRequest({
      number: 2,
      title: "stop the loop",
      buckets: ["recent"],
      updatedAt: 9_000,
    });

    const ranked = rankGithubMentionRows({
      rows: [recent, epic],
      section: "pull-requests",
      query: "stop the loop",
      limit: 10,
    });

    expect(ranked.map((row) => row.number)).toEqual([1, 2]);
  });
});

describe("githubMentionBucketRank", () => {
  it("takes a row's best bucket, not its worst", () => {
    const row = pullRequest({
      number: 1,
      title: "Both epic and recent",
      buckets: ["recent", "epic"],
    });
    expect(githubMentionBucketRank("pull-requests", row)).toBe(
      githubMentionBucketRank(
        "pull-requests",
        pullRequest({ number: 2, title: "x", buckets: ["epic"] }),
      ),
    );
    expect(githubMentionBucketRank("pull-requests", row)).toBeLessThan(
      githubMentionBucketRank(
        "pull-requests",
        pullRequest({ number: 3, title: "y", buckets: ["recent"] }),
      ),
    );
  });
});

/**
 * The coercions repair a filter persisted by an older build, or written by the
 * OTHER section - the two arms are not interchangeable (only PRs have
 * `review-requested`, only issues have `mentions`). Untested, a regression
 * that dropped the `find` fallback stayed green here and surfaced only as a
 * malformed wire request at runtime.
 */
describe("filter coercion", () => {
  const REPOSITORY = {
    githubHost: "github.com",
    owner: "traycerai",
    repo: "traycer",
  };

  it("falls back to the default when the stored involvement belongs to the other section", () => {
    expect(
      asPullRequestMentionFilter({
        state: "open",
        involvement: "mentions",
        repository: null,
      }),
    ).toEqual(DEFAULT_PULL_REQUEST_MENTION_FILTER);
    expect(
      asIssueMentionFilter({
        state: "open",
        involvement: "review-requested",
        repository: null,
      }),
    ).toEqual(DEFAULT_ISSUE_MENTION_FILTER);
  });

  it("falls back to the default when the stored state belongs to the other section", () => {
    expect(
      asIssueMentionFilter({
        state: "merged",
        involvement: "assigned",
        repository: null,
      }).state,
    ).toBe(DEFAULT_ISSUE_MENTION_FILTER.state);
  });

  it("keeps a valid selection, and carries the repository through either arm", () => {
    expect(
      asPullRequestMentionFilter({
        state: "merged",
        involvement: "review-requested",
        repository: REPOSITORY,
      }),
    ).toEqual({
      state: "merged",
      involvement: "review-requested",
      repository: REPOSITORY,
    });
    // By reference: the repository is resolved back to the scope's own object
    // elsewhere, and a coercion that rebuilt it would break that identity.
    expect(
      asIssueMentionFilter({
        state: "closed",
        involvement: "assigned",
        repository: REPOSITORY,
      }).repository,
    ).toBe(REPOSITORY);
  });
});

/**
 * The row store is one app-wide zustand store holding answers to a per-host,
 * per-epic question, so the key has to carry both. Keyed on folders alone, a
 * second tab reads the first one's rows - and because root rows are
 * immediately insertable, the user can commit a reference belonging to
 * another host or task before their own catalog answer replaces it.
 */
describe("githubMentionScopeKey", () => {
  const PATHS = ["/a", "/b"];

  it("is order-independent across the same folders", () => {
    expect(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: "epic-1",
        workspacePaths: ["/b", "/a"],
      }),
    ).toBe(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: "epic-1",
        workspacePaths: PATHS,
      }),
    );
  });

  it("separates two hosts serving identical absolute paths", () => {
    expect(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: "epic-1",
        workspacePaths: PATHS,
      }),
    ).not.toBe(
      githubMentionScopeKey({
        hostId: "host-2",
        epicId: "epic-1",
        workspacePaths: PATHS,
      }),
    );
  });

  it("separates two epics sharing the same folders", () => {
    expect(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: "epic-1",
        workspacePaths: PATHS,
      }),
    ).not.toBe(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: "epic-2",
        workspacePaths: PATHS,
      }),
    );
  });

  it("separates the landing composer from any epic on the same folders", () => {
    expect(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: null,
        workspacePaths: PATHS,
      }),
    ).not.toBe(
      githubMentionScopeKey({
        hostId: "host-1",
        epicId: "epic-1",
        workspacePaths: PATHS,
      }),
    );
  });
});
