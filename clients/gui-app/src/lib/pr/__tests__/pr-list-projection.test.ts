import { describe, it, expect } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import {
  groupPrItemsByRepo,
  prChecksSummary,
} from "@/lib/pr/pr-list-projection";

const BASE_ITEM: PrLightItem = {
  githubHost: "github.com",
  base: { owner: "traycerai", repo: "traycer-internal", prNumber: 4226 },
  prUrl: "https://github.com/traycerai/traycer-internal/pull/4226",
  state: "open",
  liveness: "live",
  observedAt: 1_000,
  isDraft: false,
  title: "Remote host support",
  baseRefName: "development",
  headRefName: "traycer/remote-host",
  additions: 10,
  deletions: 2,
  checksRollup: null,
  reviewDecision: null,
  commentCount: 0,
  updatedAt: 1_000,
  repoIdentifier: { owner: "traycerai", repo: "traycer-internal" },
  repoRole: "superproject",
  linkGroupKey: null,
  owners: [],
};

function item(overrides: Partial<PrLightItem>): PrLightItem {
  return { ...BASE_ITEM, ...overrides };
}

function submoduleItem(overrides: Partial<PrLightItem>): PrLightItem {
  return item({
    base: { owner: "traycerai", repo: "traycer", prNumber: 675 },
    prUrl: "https://github.com/traycerai/traycer/pull/675",
    repoIdentifier: { owner: "traycerai", repo: "traycer" },
    repoRole: "submodule",
    title: "Protocol bits",
    ...overrides,
  });
}

describe("groupPrItemsByRepo", () => {
  it("gives an owned-submodule PR its own repo group, right under its parent's", () => {
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/lucky-badger" }),
      submoduleItem({ linkGroupKey: "/w/lucky-badger" }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "traycer-internal",
      "traycer",
    ]);
    // A full row of its own in that group - not folded into the parent's.
    expect(groups[1]?.items.map((entry) => entry.base?.prNumber)).toEqual([
      675,
    ]);
  });

  it("pulls the submodule group up to its parent past unrelated repos", () => {
    // First-seen order alone would leave `docs` between the pair; the shared
    // link group is what makes the two read as one piece of work.
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/pair" }),
      item({
        base: { owner: "traycerai", repo: "docs", prNumber: 12 },
        repoIdentifier: { owner: "traycerai", repo: "docs" },
        linkGroupKey: null,
      }),
      submoduleItem({ linkGroupKey: "/w/pair" }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "traycer-internal",
      "traycer",
      "docs",
    ]);
  });

  it("leaves a submodule group in place when its superproject PR is absent", () => {
    const groups = groupPrItemsByRepo([
      item({
        base: { owner: "traycerai", repo: "docs", prNumber: 12 },
        repoIdentifier: { owner: "traycerai", repo: "docs" },
        linkGroupKey: null,
      }),
      submoduleItem({ linkGroupKey: "/w/orphan" }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "docs",
      "traycer",
    ]);
    expect(groups[1]?.items).toHaveLength(1);
  });

  it("does not pair across different worktrees", () => {
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/one" }),
      item({
        base: { owner: "traycerai", repo: "docs", prNumber: 12 },
        repoIdentifier: { owner: "traycerai", repo: "docs" },
        linkGroupKey: null,
      }),
      submoduleItem({ linkGroupKey: "/w/two" }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "traycer-internal",
      "docs",
      "traycer",
    ]);
  });

  it("moves a repo contributing several submodule PRs exactly once", () => {
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/multi" }),
      submoduleItem({ linkGroupKey: "/w/multi" }),
      submoduleItem({
        linkGroupKey: "/w/multi",
        base: { owner: "traycerai", repo: "traycer", prNumber: 676 },
      }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "traycer-internal",
      "traycer",
    ]);
    expect(groups[1]?.items).toHaveLength(2);
  });

  it("keeps a group whose parent is itself a submodule of another group", () => {
    // `traycer` is a submodule under /w/outer AND the superproject that owns
    // `docs` under /w/inner. Expanding followers one level deep emitted
    // `traycer` as a follower of `traycer-internal` and then dropped `docs`
    // entirely - its `pulled` entry kept it out of the first-seen pass and
    // nothing re-emitted it.
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/outer" }),
      submoduleItem({ linkGroupKey: "/w/outer" }),
      submoduleItem({
        repoIdentifier: { owner: "traycerai", repo: "traycer" },
        repoRole: "superproject",
        linkGroupKey: "/w/inner",
        base: { owner: "traycerai", repo: "traycer", prNumber: 676 },
      }),
      item({
        base: { owner: "traycerai", repo: "docs", prNumber: 12 },
        repoIdentifier: { owner: "traycerai", repo: "docs" },
        repoRole: "submodule",
        linkGroupKey: "/w/inner",
      }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "traycer-internal",
      "traycer",
      "docs",
    ]);
  });

  it("emits every group even when two groups pull each other", () => {
    // A cycle leaves no root to expand from, so the first pass emits nothing
    // for either group; both must still reach the output rather than vanish.
    const groups = groupPrItemsByRepo([
      item({ repoRole: "superproject", linkGroupKey: "/w/a" }),
      submoduleItem({ repoRole: "submodule", linkGroupKey: "/w/a" }),
      submoduleItem({
        repoRole: "superproject",
        linkGroupKey: "/w/b",
        base: { owner: "traycerai", repo: "traycer", prNumber: 676 },
      }),
      item({ repoRole: "submodule", linkGroupKey: "/w/b" }),
    ]);

    expect(
      [...groups.map((group) => group.repoIdentifier.repo)].sort(),
    ).toEqual(["traycer", "traycer-internal"]);
  });

  it("orders rows open → merged → closed within a group", () => {
    const groups = groupPrItemsByRepo([
      item({ state: "closed", base: null, headRefName: "closed-head" }),
      item({ state: "merged", base: null, headRefName: "merged-head" }),
      item({ state: "open", base: null, headRefName: "open-head" }),
    ]);

    expect(groups[0]?.items.map((entry) => entry.state)).toEqual([
      "open",
      "merged",
      "closed",
    ]);
  });
});

describe("prChecksSummary", () => {
  it("is null when there are no checks at all", () => {
    expect(prChecksSummary(null)).toBeNull();
    expect(
      prChecksSummary({ success: 0, failure: 0, pending: 0, total: 0 }),
    ).toBeNull();
  });

  it("leads with failures even when most checks passed", () => {
    const summary = prChecksSummary({
      success: 10,
      failure: 1,
      pending: 3,
      total: 14,
    });

    expect(summary?.tone).toBe("fail");
    expect(summary?.label).toBe("1 failing");
    expect(summary?.detail).toBe(
      "1 failing · 3 running · 10 passed · 14 total",
    );
  });

  it("reports running checks when nothing has failed", () => {
    const summary = prChecksSummary({
      success: 10,
      failure: 0,
      pending: 3,
      total: 13,
    });

    expect(summary?.tone).toBe("pending");
    expect(summary?.label).toBe("3 running");
  });

  it("reports a clean run as passed", () => {
    const summary = prChecksSummary({
      success: 10,
      failure: 0,
      pending: 0,
      total: 10,
    });

    expect(summary?.tone).toBe("ok");
    expect(summary?.label).toBe("10 passed");
  });

  it("does not claim success when every context settled outside the three buckets", () => {
    const summary = prChecksSummary({
      success: 0,
      failure: 0,
      pending: 0,
      total: 4,
    });

    expect(summary?.tone).toBe("none");
    expect(summary?.label).toBe("4 checks");
  });
});
