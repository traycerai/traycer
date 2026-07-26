import { describe, it, expect } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import {
  groupPrItemsByRepo,
  linkPrItems,
  prChecksSummary,
  prLinkedRowIdentityLabel,
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

describe("linkPrItems", () => {
  it("nests an owned-submodule PR under the superproject PR sharing its link group", () => {
    const nodes = linkPrItems([
      item({ linkGroupKey: "/w/lucky-badger" }),
      submoduleItem({ linkGroupKey: "/w/lucky-badger" }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.item.base?.prNumber).toBe(4226);
    expect(nodes[0]?.linked.map((linked) => linked.base?.prNumber)).toEqual([
      675,
    ]);
  });

  it("keeps a submodule PR top-level when its superproject PR is absent", () => {
    const nodes = linkPrItems([submoduleItem({ linkGroupKey: "/w/orphan" })]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.item.base?.prNumber).toBe(675);
    expect(nodes[0]?.linked).toEqual([]);
  });

  it("does not link across different worktrees", () => {
    const nodes = linkPrItems([
      item({ linkGroupKey: "/w/one" }),
      submoduleItem({ linkGroupKey: "/w/two" }),
    ]);

    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.linked.length === 0)).toBe(true);
  });

  it("never links rows whose link group is unknown", () => {
    const nodes = linkPrItems([
      item({ linkGroupKey: null }),
      submoduleItem({ linkGroupKey: null }),
    ]);

    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.linked.length === 0)).toBe(true);
  });

  it("nests every submodule of one worktree under the same parent", () => {
    const nodes = linkPrItems([
      item({ linkGroupKey: "/w/multi" }),
      submoduleItem({ linkGroupKey: "/w/multi" }),
      submoduleItem({
        linkGroupKey: "/w/multi",
        base: { owner: "traycerai", repo: "docs", prNumber: 12 },
        repoIdentifier: { owner: "traycerai", repo: "docs" },
      }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.linked).toHaveLength(2);
  });
});

describe("groupPrItemsByRepo", () => {
  it("drops the repo group of a submodule PR that nested elsewhere", () => {
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/lucky-badger" }),
      submoduleItem({ linkGroupKey: "/w/lucky-badger" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.repoIdentifier.repo).toBe("traycer-internal");
    // The count the header renders must be the top-level rows, not every PR.
    expect(groups[0]?.nodes).toHaveLength(1);
    expect(groups[0]?.nodes[0]?.linked).toHaveLength(1);
  });

  it("keeps an unlinked submodule PR in its own repo group", () => {
    const groups = groupPrItemsByRepo([
      item({ linkGroupKey: "/w/one" }),
      submoduleItem({ linkGroupKey: "/w/two" }),
    ]);

    expect(groups.map((group) => group.repoIdentifier.repo)).toEqual([
      "traycer-internal",
      "traycer",
    ]);
  });

  it("orders rows open → merged → closed within a group", () => {
    const groups = groupPrItemsByRepo([
      item({ state: "closed", base: null, headRefName: "closed-head" }),
      item({ state: "merged", base: null, headRefName: "merged-head" }),
      item({ state: "open", base: null, headRefName: "open-head" }),
    ]);

    expect(groups[0]?.nodes.map((node) => node.item.state)).toEqual([
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

describe("prLinkedRowIdentityLabel", () => {
  it("leads with the submodule repo the nested PR lives in", () => {
    expect(prLinkedRowIdentityLabel(submoduleItem({}))).toBe("traycer #675");
  });

  it("falls back to the head ref when the base is unknown", () => {
    expect(
      prLinkedRowIdentityLabel(
        submoduleItem({ base: null, headRefName: "feature/sub" }),
      ),
    ).toBe("traycer feature/sub");
  });
});
