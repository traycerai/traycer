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
  githubMentionRowsWithinScope,
  mergeGithubMentionRows,
  parseGithubReferenceQuery,
  rankGithubMentionRows,
  withGithubMentionSectionShape,
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

/**
 * The scope boundary is case-insensitive because the two sides of the
 * comparison have different provenance: rows carry the API's canonical
 * casing, while a scope's repositories are parsed from the folder's
 * configured remote - whatever casing the user happened to type there.
 */
describe("githubMentionRowsWithinScope", () => {
  it("keeps a row when the scope's repository differs from the row only in casing", () => {
    const row = pullRequest({
      number: 1,
      title: "Casing",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
    });
    const rows = [row];

    const kept = githubMentionRowsWithinScope(rows, [
      { githubHost: "GitHub.com", owner: "TraycerAI", repo: "Traycer" },
    ]);

    expect(kept).toEqual([row]);
    // Identity-preserving: nothing was actually dropped, so the input array
    // itself comes back rather than a fresh-but-equal copy.
    expect(kept).toBe(rows);
  });

  it("still drops a row whose repository is genuinely different despite case folding", () => {
    // The control. Without it, folding the comparison could quietly widen
    // into matching ANY casing of ANY repository rather than the same one.
    const inScope = pullRequest({
      number: 2,
      title: "In scope",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
    });
    const outOfScope = pullRequest({
      number: 3,
      title: "Out of scope",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer-internal",
    });

    const kept = githubMentionRowsWithinScope(
      [inScope, outOfScope],
      [{ githubHost: "GitHub.com", owner: "TraycerAI", repo: "TRAYCER" }],
    );

    expect(kept).toEqual([inScope]);
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

  // The identity key folds host/owner/repo casing (see `githubMentionRowKey`),
  // because a cached sweep and a live search can spell the same repository
  // differently. Compared verbatim, the remote hit would append as a second
  // row instead of refreshing the stale one, and either copy could then be
  // committed as a mention.
  it("merges a cached row and a remote hit naming the same artifact with different casing", () => {
    const cached = pullRequest({
      number: 4917,
      title: "Stop the busy-loop",
      owner: "acme",
      repo: "api",
      buckets: ["epic"],
    });
    const remoteTwin = pullRequest({
      number: 4917,
      title: "Stop the busy-loop (remote title)",
      owner: "Acme",
      repo: "API",
      buckets: ["search"],
    });

    const merged = mergeGithubMentionRows([cached], [remoteTwin]);

    // One row, at the cached position, carrying the remote's fresh payload -
    // the same split the same-casing merge test above asserts.
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(remoteTwin);
    expect(merged[0].title).toBe("Stop the busy-loop (remote title)");
  });

  it("still appends a remote row naming a genuinely different repository", () => {
    // The control. Without it, folding the merge key could quietly widen into
    // treating any two rows that merely share a number as the same artifact.
    const cached = pullRequest({
      number: 4917,
      title: "Stop the busy-loop",
      owner: "acme",
      repo: "api",
      buckets: ["epic"],
    });
    const differentRepo = pullRequest({
      number: 4917,
      title: "Unrelated PR with the same number",
      owner: "acme",
      repo: "widgets",
      buckets: ["search"],
    });

    const merged = mergeGithubMentionRows([cached], [differentRepo]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(cached);
    expect(merged[1]).toBe(differentRepo);
  });
});

describe("githubMentionRowKey", () => {
  it("folds host/owner/repo casing so the two spellings key identically", () => {
    const lower = pullRequest({
      number: 1,
      title: "a",
      githubHost: "github.com",
      owner: "acme",
      repo: "api",
    });
    const upper = pullRequest({
      number: 1,
      title: "b",
      githubHost: "GitHub.com",
      owner: "Acme",
      repo: "API",
    });

    expect(githubMentionRowKey(lower)).toBe(githubMentionRowKey(upper));
  });

  it("still differs when the number differs", () => {
    // The control: casing folds, but the number is compared as-is.
    const first = pullRequest({
      number: 1,
      title: "a",
      owner: "acme",
      repo: "api",
    });
    const second = pullRequest({
      number: 2,
      title: "b",
      owner: "acme",
      repo: "api",
    });

    expect(githubMentionRowKey(first)).not.toBe(githubMentionRowKey(second));
  });
});

describe("parseGithubReferenceQuery", () => {
  it("recognizes a bare #number reference", () => {
    expect(parseGithubReferenceQuery("#123")).toEqual({
      kind: "number",
      number: 123,
    });
  });

  // A bare digit query is exact-number intent exactly like its `#`-prefixed
  // twin - `numberMatchScore` already treated bare digits that way, and the
  // parser must agree, or a bare `4917` scores as a number match but earns
  // neither a `Resolve in ...` row nor the zero-match dismissal exemption.
  it("recognizes a bare digit query as a number reference, matching the #-prefixed form", () => {
    expect(parseGithubReferenceQuery("4917")).toEqual({
      kind: "number",
      number: 4917,
    });
    expect(parseGithubReferenceQuery("#4917")).toEqual({
      kind: "number",
      number: 4917,
    });
  });

  it("recognizes org/repo#number", () => {
    expect(parseGithubReferenceQuery("org/repo#123")).toEqual({
      kind: "repository",
      githubHost: null,
      owner: "org",
      repo: "repo",
      number: 123,
    });
  });

  it("recognizes host/owner/repo#number as a host-qualified repository reference", () => {
    // Three segments parse as the host-qualified form - the exact identity
    // the UI prints when a scope holds the same owner/repo on two hosts, so
    // typing that displayed form back must parse into the reference it is.
    expect(
      parseGithubReferenceQuery("ghe.example.test/acme/widgets#7"),
    ).toEqual({
      kind: "repository",
      githubHost: "ghe.example.test",
      owner: "acme",
      repo: "widgets",
      number: 7,
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

  // A bare digit query is number-intent ONLY when the whole query is digits.
  // Anything else - trailing letters, a leading letter, a digit sitting
  // inside a sentence - stays prose, exactly as it did before bare digits
  // were recognized at all.
  it("keeps a query with digits AND other characters as prose, not a reference", () => {
    expect(parseGithubReferenceQuery("4917x")).toBeNull();
    expect(parseGithubReferenceQuery("v123")).toBeNull();
    expect(parseGithubReferenceQuery("2024 was fun")).toBeNull();
  });

  it("rejects a zero-valued number in every reference shape", () => {
    // `\d{1,7}` matches these, but the wire row schema requires a positive
    // number - so classifying them as references suppresses root's zero-match
    // auto-close and offers a Resolve row for an item that cannot exist.
    expect(parseGithubReferenceQuery("#0")).toBeNull();
    expect(parseGithubReferenceQuery("#000")).toBeNull();
    // Same positivity rule on the bare (no `#`) form the parser now accepts.
    expect(parseGithubReferenceQuery("0")).toBeNull();
    expect(parseGithubReferenceQuery("000")).toBeNull();
    expect(parseGithubReferenceQuery("org/repo#0")).toBeNull();
    expect(
      parseGithubReferenceQuery("https://github.com/org/repo/pull/0"),
    ).toBeNull();
    expect(
      parseGithubReferenceQuery("https://github.com/org/repo/issues/0"),
    ).toBeNull();
  });

  it("still accepts the smallest real reference", () => {
    // The control: a positivity guard that rejected everything would pass the
    // case above on its own.
    expect(parseGithubReferenceQuery("#1")).toEqual({
      kind: "number",
      number: 1,
    });
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

  it("does not treat a pull-request URL as an exact match for an issue", () => {
    // GitHub numbers PRs and issues from one sequence, so issue 4917 can exist
    // beside pull request 4917. A URL says which KIND it names; scoring the
    // wrong-kind row 0 floated it to the top of the Issues section and let
    // Enter insert a `github_issue` chip for a `/pull/` link.
    const wrongKind = issue({ number: 4917, title: "Stop the busy-loop" });

    expect(
      githubMentionMatchScore(
        wrongKind,
        "https://github.com/traycerai/traycer/pull/4917",
      ),
    ).not.toBe(0);
  });

  it("does not treat an issue URL as an exact match for a pull request", () => {
    const wrongKind = pullRequest({
      number: 4917,
      title: "Stop the busy-loop",
    });

    expect(
      githubMentionMatchScore(
        wrongKind,
        "https://github.com/traycerai/traycer/issues/4917",
      ),
    ).not.toBe(0);
  });

  it("still matches the URL's own kind exactly", () => {
    // The control. The section check must not cost a URL its exact rank on the
    // row it actually names.
    const rightKind = issue({ number: 4917, title: "Stop the busy-loop" });

    expect(
      githubMentionMatchScore(
        rightKind,
        "https://github.com/traycerai/traycer/issues/4917",
      ),
    ).toBe(0);
  });

  it("keeps a kind-agnostic reference matching both kinds", () => {
    // The other control, and the reason the check is URL-only: `#123` and
    // `org/repo#123` genuinely can name either, so narrowing them by kind
    // would break the bare-number lookup this feature is built around.
    expect(
      githubMentionMatchScore(
        issue({ number: 812, title: "Magic link" }),
        "#812",
      ),
    ).toBe(0);
    expect(
      githubMentionMatchScore(
        pullRequest({ number: 812, title: "Magic link" }),
        "traycerai/traycer#812",
      ),
    ).toBe(0);
  });

  it("matches a pasted URL whose host differs only in case", () => {
    // Hostnames are case-insensitive, and `owner`/`repo` are already compared
    // case-folded. A host compared exactly would drop this URL out of the
    // exact-reference rank and leave it to score as ordinary text - so the row
    // the user pasted the link for stops sitting first.
    const row = pullRequest({ number: 4917, title: "Stop the busy-loop" });

    expect(
      githubMentionMatchScore(
        row,
        "https://GitHub.com/traycerai/traycer/pull/4917",
      ),
    ).toBe(0);
  });

  it("matches a host-qualified query naming the row's own enterprise host", () => {
    // The UI prints `host/owner/repo` when a scope holds the same owner/repo
    // on two hosts (see `githubRepositoryQualification`), so a matcher that
    // cannot re-match the identity the row DISPLAYS would drop the row the
    // moment the user types back what they see.
    const enterprise = pullRequest({
      number: 1,
      title: "Enterprise PR",
      githubHost: "ghe.example.test",
      owner: "acme",
      repo: "widgets",
    });

    expect(
      githubMentionMatchScore(enterprise, "ghe.example.test/acme/widgets"),
    ).toBe(400);
  });

  it("does not match a different host's identical owner/repo against a host-qualified query", () => {
    // The control. Without it, the qualified haystack could quietly widen
    // into matching ANY host sharing the same owner/repo rather than only the
    // host actually named in the query.
    const githubCom = pullRequest({
      number: 2,
      title: "Public PR",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
    });

    expect(
      githubMentionMatchScore(githubCom, "ghe.example.test/acme/widgets"),
    ).toBeNull();
  });

  it("still matches a host-agnostic owner/repo query on either host", () => {
    // The other control: `owner/repo` alone must keep matching a row on
    // EITHER host, because it names no host at all.
    const enterprise = pullRequest({
      number: 3,
      title: "Enterprise PR",
      githubHost: "ghe.example.test",
      owner: "acme",
      repo: "widgets",
    });
    const githubCom = pullRequest({
      number: 4,
      title: "Public PR",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
    });

    expect(githubMentionMatchScore(enterprise, "acme/widgets")).toBe(400);
    expect(githubMentionMatchScore(githubCom, "acme/widgets")).toBe(400);
  });

  it("ranks a host-qualified reference query 0 for only the row on that host", () => {
    // A host-qualified `host/owner/repo#number` names ONE host's row, exactly
    // like a pasted URL does - the two-segment `owner/repo#number` form stays
    // host-agnostic, but three segments say which host.
    const enterprise = pullRequest({
      number: 7,
      title: "Enterprise PR",
      githubHost: "ghe.example.test",
      owner: "acme",
      repo: "widgets",
    });
    const githubCom = pullRequest({
      number: 7,
      title: "Public PR",
      githubHost: "github.com",
      owner: "acme",
      repo: "widgets",
    });

    expect(
      githubMentionMatchScore(enterprise, "ghe.example.test/acme/widgets#7"),
    ).toBe(0);
    expect(
      githubMentionMatchScore(githubCom, "ghe.example.test/acme/widgets#7"),
    ).not.toBe(0);
  });

  it("case-folds the host in a host-qualified reference query", () => {
    // Hostnames are case-insensitive, and `owner`/`repo` are already compared
    // case-folded on this path.
    const enterprise = pullRequest({
      number: 7,
      title: "Enterprise PR",
      githubHost: "ghe.example.test",
      owner: "acme",
      repo: "widgets",
    });

    expect(
      githubMentionMatchScore(enterprise, "GHE.Example.TEST/Acme/Widgets#7"),
    ).toBe(0);
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

  it("matches a repository selection that differs from the row only in casing", () => {
    // The row is API-cased; the selection is parsed from the folder's
    // configured remote, which can be spelled with different casing for the
    // same repository - so the comparison must fold case like the scope
    // boundary above it.
    const row = pullRequest({
      number: 100,
      title: "Casing",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
      state: "open",
    });

    const filtered = filterGithubMentionRows([row], "pull-requests", {
      ...DEFAULT_PULL_REQUEST_MENTION_FILTER,
      repository: {
        githubHost: "GitHub.com",
        owner: "TraycerAI",
        repo: "Traycer",
      },
    });

    expect(filtered).toEqual([row]);
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

  it("returns the SAME filter object when there is nothing to coerce", () => {
    // Identity, not equality. This runs inside a store selector, whose result
    // is compared by reference to decide whether to re-render: a fresh-but-
    // equal object on every read is an unbroken render loop, not a wasted
    // allocation. (It was exactly that, once.)
    const valid = {
      state: "merged",
      involvement: "review-requested",
      repository: REPOSITORY,
    } as const;

    expect(withGithubMentionSectionShape("pull-requests", valid)).toBe(valid);
  });

  it("rebuilds only when a stored value does not belong to the section", () => {
    const crossSection = {
      state: "merged",
      involvement: "review-requested",
      repository: REPOSITORY,
    } as const;

    const coerced = withGithubMentionSectionShape("issues", crossSection);

    expect(coerced).not.toBe(crossSection);
    expect(coerced.state).toBe(DEFAULT_ISSUE_MENTION_FILTER.state);
    expect(coerced.involvement).toBe(DEFAULT_ISSUE_MENTION_FILTER.involvement);
    // The selection survives the rebuild - it is section-independent.
    expect(coerced.repository).toBe(REPOSITORY);
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
