import { describe, expect, it, vi } from "vitest";
import {
  createWorktreeBranchSearchIndex,
  filterWorktreeBranchRows,
  pathSearchBasename,
  pathSearchTail,
  type WorktreeBranchSearchRow,
} from "@/components/home/data/worktree-branch-search";

function searchRow(
  id: string,
  branch: string,
  path: string,
): WorktreeBranchSearchRow {
  return {
    id,
    searchBranch: branch,
    searchPathTail: pathSearchTail(path),
    searchPathBasename: pathSearchBasename(path),
    searchFullPath: path,
  };
}

describe("worktree branch search", () => {
  it("preserves input order when the query is empty", () => {
    const rows = [
      searchRow("one", "main", "/repo/main"),
      searchRow("two", "feature/payments", "/repo/worktrees/payments"),
      searchRow("three", "bugfix/login", "/repo/worktrees/login"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "").map((row) => row.id),
    ).toEqual(["one", "two", "three"]);
  });

  it("ranks branch-name matches above path-tail matches", () => {
    const rows = [
      searchRow("path", "maintenance", "/repo/worktrees/feature-payments"),
      searchRow("branch", "feature/payments", "/repo/worktrees/alpha"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "feature").map((row) => row.id),
    ).toEqual(["branch", "path"]);
  });

  it("finds typo-tolerant branch matches and path-tail fallbacks", () => {
    const rows = [
      searchRow("sonnet", "feature/sonnet-model", "/repo/worktrees/model"),
      searchRow("tail", "main", "/Users/me/worktrees/zebra-checkout"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "sonet").map((row) => row.id),
    ).toEqual(["sonnet"]);
    expect(
      filterWorktreeBranchRows(rows, index, "zebra").map((row) => row.id),
    ).toEqual(["tail"]);
  });

  it("uses the last path segments for tail search", () => {
    expect(pathSearchTail("/Users/me/worktrees/repo-feature-x")).toBe(
      "me/worktrees/repo-feature-x",
    );
    expect(pathSearchBasename("/Users/me/worktrees/repo-feature-x")).toBe(
      "repo-feature-x",
    );
  });

  it("matches substrings case-insensitively", () => {
    const rows = [
      searchRow("one", "Feature/Payments", "/repo/worktrees/alpha"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "PAYMENTS").map((row) => row.id),
    ).toEqual(["one"]);
  });

  it("ranks a branch-name substring hit above a path-only substring hit, using the substring path exclusively", () => {
    const rows = [
      searchRow("branch", "hotfix/urgent-patch", "/repo/worktrees/alpha"),
      searchRow("path", "misc", "/repo/worktrees/urgent-workdir"),
    ];
    // Index over zero rows: Fuse can never produce a hit from it, so a
    // non-empty, correctly ordered result proves the substring tiers were
    // used exclusively rather than falling through to fuzzy search.
    const emptyIndex = createWorktreeBranchSearchIndex<(typeof rows)[number]>(
      [],
    );

    expect(
      filterWorktreeBranchRows(rows, emptyIndex, "urgent").map((row) => row.id),
    ).toEqual(["branch", "path"]);
  });

  it("ranks an exact branch-name match above rows that merely contain the query", () => {
    // Input order is deliberately NOT rank order, so a raw-order bug would
    // fail this assertion.
    const rows = [
      searchRow("domain", "chore/domain-cleanup", "/repo/worktrees/domain"),
      searchRow("main", "main", "/repo/main"),
      searchRow("release", "release/main-backport", "/repo/worktrees/release"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "main").map((row) => row.id),
    ).toEqual(["main", "domain", "release"]);
  });

  it("ranks a prefix match above mere containment within the same tier, shorter prefix first", () => {
    // "dev-tools" and "development-notes" both start with "dev" (prefix
    // matches); "middev" only contains "dev" mid-string. Among the two
    // prefix matches, the shorter field ("dev-tools") ranks first.
    const rows = [
      searchRow(
        "development",
        "development-notes",
        "/repo/worktrees/development",
      ),
      searchRow("middev", "middev", "/repo/worktrees/middev"),
      searchRow("devtools", "dev-tools", "/repo/worktrees/devtools"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "dev").map((row) => row.id),
    ).toEqual(["devtools", "development", "middev"]);
  });

  it("matches an exact branch name case-insensitively, still ranked first", () => {
    const rows = [
      searchRow("domain", "chore/domain-cleanup", "/repo/worktrees/domain"),
      searchRow("main", "main", "/repo/main"),
      searchRow("release", "release/main-backport", "/repo/worktrees/release"),
    ];
    const index = createWorktreeBranchSearchIndex(rows);

    expect(
      filterWorktreeBranchRows(rows, index, "MAIN").map((row) => row.id),
    ).toEqual(["main", "domain", "release"]);
  });

  it("serves queries over FUZZY_QUERY_MAX_LENGTH from substring matches only, with no fuzzy fallback", () => {
    const longBranch = "feature-integration-with-payments-flow-long";
    const rows = [searchRow("one", longBranch, "/repo/worktrees/alpha")];
    const index = createWorktreeBranchSearchIndex(rows);
    // The gate is about the CALL, not just the result: spy on the index so a
    // silent fuzzy pass cannot hide behind an empty result set.
    const search = vi.spyOn(index, "search");

    // Exact (long) substring hit still returns.
    expect(longBranch.length).toBeGreaterThan(32);
    expect(
      filterWorktreeBranchRows(rows, index, longBranch).map((row) => row.id),
    ).toEqual(["one"]);

    // A one-character typo of the same long query breaks the substring match;
    // Fuse would typically typo-tolerate it, but the length gate skips Fuse
    // entirely, so the result must be empty.
    const typoQuery = "feature-integration-with-paymentz-flow-long";
    expect(typoQuery.length).toBeGreaterThan(32);
    expect(filterWorktreeBranchRows(rows, index, typoQuery)).toEqual([]);
    expect(search).not.toHaveBeenCalled();

    // Control: the same spy DOES record a call once the query is short enough
    // to earn the fuzzy fallback, so the zero-call assertion above is evidence
    // of the length gate rather than of a spy that can never fire.
    const shortTypo = "paymentz";
    expect(shortTypo.length).toBeLessThanOrEqual(32);
    filterWorktreeBranchRows(rows, index, shortTypo);
    expect(search).toHaveBeenCalledWith(shortTypo);
  });
});
