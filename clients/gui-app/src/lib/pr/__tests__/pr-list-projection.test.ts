import { describe, it, expect } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import {
  filterPrRepoGroups,
  formatPrRowTitle,
  formatPrStackCount,
  groupPrItemsByRepo,
  prChecksSummary,
  prRowTitleText,
  prStackRailEntries,
  type PrRepoBlock,
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

describe("prRowTitleText / formatPrRowTitle", () => {
  it("reports NO title for a never-swept row rather than inventing one", () => {
    // An unswept row genuinely has no title. The previous shape filled the
    // gap with an "Untitled pull request" placeholder, which rendered a blank
    // second line on every such row and claimed a fact the host never sent.
    expect(prRowTitleText(item({ title: null }))).toBeNull();
    expect(prRowTitleText(item({ title: "" }))).toBeNull();
  });

  it("falls back to the bare identity when the title is absent", () => {
    expect(formatPrRowTitle(item({ title: null }))).toBe("#4226");
    expect(
      formatPrRowTitle(item({ title: null, base: null, headRefName: "wip" })),
    ).toBe("wip");
  });

  it("joins identity and title when both are known", () => {
    expect(formatPrRowTitle(item({}))).toBe("#4226 · Remote host support");
  });
});

describe("groupPrItemsByRepo stack blocks", () => {
  type StackBlock = Extract<PrRepoBlock, { readonly kind: "stack" }>;

  /** A row identified by its PR number, with its own branch pair. */
  function pr(prNumber: number, overrides: Partial<PrLightItem>): PrLightItem {
    return item({
      base: { owner: "traycerai", repo: "traycer-internal", prNumber },
      headRefName: `branch-${prNumber}`,
      ...overrides,
    });
  }

  function numbers(
    rows: readonly PrLightItem[],
  ): readonly (number | undefined)[] {
    return rows.map((row) => row.base?.prNumber);
  }

  function onlyBlocks(rows: readonly PrLightItem[]): readonly PrRepoBlock[] {
    const group = groupPrItemsByRepo(rows).at(0);
    if (group === undefined) throw new Error("expected one group");
    return group.blocks;
  }

  function asStack(block: PrRepoBlock | undefined): StackBlock {
    if (block === undefined || block.kind !== "stack") {
      throw new Error("expected a stack block");
    }
    return block;
  }

  function nativeStack(position: number, size: number): PrLightItem["stack"] {
    return { number: 9, baseRefName: "development", size, position };
  }

  it("gathers rows sharing a native stack number, in position order", () => {
    const blocks = onlyBlocks([
      pr(3, { stack: nativeStack(3, 3) }),
      pr(1, { stack: nativeStack(1, 3) }),
      pr(2, { stack: nativeStack(2, 3) }),
    ]);

    expect(blocks).toHaveLength(1);
    const stack = asStack(blocks.at(0));
    expect(numbers(stack.layers)).toEqual([1, 2, 3]);
    expect(stack.baseRefName).toBe("development");
    expect(stack.size).toBe(3);
    expect(stack.key).toBe("native:9");
  });

  it("keeps GitHub's size when the list carries only some of a native stack's layers", () => {
    const blocks = onlyBlocks([
      pr(30, { stack: nativeStack(3, 5) }),
      pr(10, { stack: nativeStack(1, 5) }),
    ]);

    const stack = asStack(blocks.at(0));
    expect(numbers(stack.layers)).toEqual([10, 30]);
    expect(stack.size).toBe(5);
    expect(formatPrStackCount(stack)).toBe("2 of 5");
  });

  it("treats a native stack of size one as a lone row", () => {
    const blocks = onlyBlocks([pr(1, { stack: nativeStack(1, 1) })]);

    expect(blocks).toHaveLength(1);
    expect(blocks.at(0)?.kind).toBe("single");
  });

  it("infers a chain of three from base and head branches, bottom to top", () => {
    const blocks = onlyBlocks([
      pr(3, { headRefName: "c", baseRefName: "b" }),
      pr(1, { headRefName: "a", baseRefName: "main" }),
      pr(2, { headRefName: "b", baseRefName: "a" }),
    ]);

    expect(blocks).toHaveLength(1);
    const stack = asStack(blocks.at(0));
    expect(numbers(stack.layers)).toEqual([1, 2, 3]);
    // The stack lands where its bottom layer lands, not on a sibling's head.
    expect(stack.baseRefName).toBe("main");
    expect(stack.size).toBe(3);
    expect(stack.key.startsWith("inferred:")).toBe(true);
    expect(formatPrStackCount(stack)).toBe("3");
  });

  it("leaves unrelated rows as singles", () => {
    const blocks = onlyBlocks([
      pr(1, { headRefName: "a", baseRefName: "main" }),
      pr(2, { headRefName: "b", baseRefName: "main" }),
      pr(3, { headRefName: "c", baseRefName: "other" }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "single",
      "single",
      "single",
    ]);
  });

  it("keeps a fan-in as singles: three PRs targeting one PR's head", () => {
    // A promotion PR (development → main) with feature PRs targeting its head
    // is a tree, not a stack.
    const blocks = onlyBlocks([
      pr(1, { headRefName: "development", baseRefName: "main" }),
      pr(2, { headRefName: "feat-a", baseRefName: "development" }),
      pr(3, { headRefName: "feat-b", baseRefName: "development" }),
      pr(4, { headRefName: "feat-c", baseRefName: "development" }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "single",
      "single",
      "single",
      "single",
    ]);
  });

  it("keeps a fan-out as singles: one PR whose base is two PRs' head", () => {
    const blocks = onlyBlocks([
      pr(1, { headRefName: "a", baseRefName: "main" }),
      pr(2, { headRefName: "a", baseRefName: "main" }),
      pr(3, { headRefName: "b", baseRefName: "a" }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "single",
      "single",
      "single",
    ]);
  });

  it("still stacks a strict chain sitting beside a fan-in", () => {
    const blocks = onlyBlocks([
      pr(1, { headRefName: "development", baseRefName: "main" }),
      pr(2, { headRefName: "feat-a", baseRefName: "development" }),
      pr(3, { headRefName: "feat-b", baseRefName: "development" }),
      pr(4, { headRefName: "feat-b-2", baseRefName: "feat-b" }),
    ]);

    const stacks = blocks.filter((block) => block.kind === "stack");
    expect(stacks).toHaveLength(1);
    const stack = asStack(stacks.at(0));
    expect(numbers(stack.layers)).toEqual([3, 4]);
    expect(stack.baseRefName).toBe("development");
    expect(blocks).toHaveLength(3);
  });

  it("does not stack a row with a missing branch name onto another", () => {
    const blocks = onlyBlocks([
      pr(1, { headRefName: null, baseRefName: null }),
      pr(2, { headRefName: null, baseRefName: null }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(["single", "single"]);
  });

  it("terminates on a cycle and keeps one stack of two in first-seen order", () => {
    const blocks = onlyBlocks([
      pr(1, { headRefName: "a", baseRefName: "b" }),
      pr(2, { headRefName: "b", baseRefName: "a" }),
    ]);

    expect(blocks).toHaveLength(1);
    const stack = asStack(blocks.at(0));
    expect(numbers(stack.layers)).toEqual([1, 2]);
    expect(stack.size).toBe(2);
  });

  it("ranks a lone open row ahead of a stack that is entirely merged", () => {
    const blocks = onlyBlocks([
      pr(1, { state: "merged", stack: nativeStack(1, 2), updatedAt: 9_000 }),
      pr(2, { state: "merged", stack: nativeStack(2, 2), updatedAt: 9_000 }),
      pr(3, { state: "open", updatedAt: 100 }),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(["single", "stack"]);
  });

  it("ranks a stack holding one open layer with the open rows, by recency", () => {
    const blocks = onlyBlocks([
      pr(1, { state: "merged", stack: nativeStack(1, 2), updatedAt: 500 }),
      pr(2, { state: "open", stack: nativeStack(2, 2), updatedAt: 400 }),
      pr(3, { state: "open", updatedAt: 100 }),
      pr(4, { state: "merged", updatedAt: 9_000 }),
    ]);

    // The stack's freshest layer (500) beats the lone open row (100); the
    // merged single trails both however recently it moved.
    expect(blocks.map((block) => block.kind)).toEqual([
      "stack",
      "single",
      "single",
    ]);
    expect(
      blocks.map((block) =>
        block.kind === "single" ? block.item.base?.prNumber : "stack",
      ),
    ).toEqual(["stack", 3, 4]);
  });

  it("lets layer order win over state inside a stack", () => {
    const blocks = onlyBlocks([
      pr(1, { state: "merged", stack: nativeStack(1, 2) }),
      pr(2, { state: "open", stack: nativeStack(2, 2) }),
    ]);

    const stack = asStack(blocks.at(0));
    expect(stack.layers.map((layer) => layer.state)).toEqual([
      "merged",
      "open",
    ]);
  });

  it("leaves the group's flat items in open, merged, closed order whatever the stacks", () => {
    const group = groupPrItemsByRepo([
      pr(1, { state: "merged", stack: nativeStack(1, 2) }),
      pr(2, { state: "open", stack: nativeStack(2, 2) }),
      pr(3, { state: "closed" }),
      pr(4, { state: "open" }),
    ]).at(0);

    expect(group).toBeDefined();
    expect(group?.items.map((entry) => entry.state)).toEqual([
      "open",
      "open",
      "merged",
      "closed",
    ]);
    expect(numbers(group?.items ?? [])).toEqual([2, 4, 1, 3]);
  });

  describe("filterPrRepoGroups", () => {
    const isOpen = (row: PrLightItem): boolean => row.state === "open";

    it("keeps a fan-in as singles when the filter hides one of its rows", () => {
      // Filtering the list first would leave development with one
      // dependent, which inference reads as a chain. Grouping first does not.
      const groups = groupPrItemsByRepo([
        pr(1, { headRefName: "development", baseRefName: "main" }),
        pr(2, { headRefName: "feat-open", baseRefName: "development" }),
        pr(3, {
          headRefName: "feat-merged",
          baseRefName: "development",
          state: "merged",
        }),
      ]);

      const visible = filterPrRepoGroups(groups, isOpen);
      expect(numbers(visible[0].items)).toEqual([1, 2]);
      expect(visible[0].blocks.map((block) => block.kind)).toEqual([
        "single",
        "single",
      ]);
    });

    it("trims a stack's hidden layers and keeps its size", () => {
      const groups = groupPrItemsByRepo([
        pr(1, { headRefName: "a", baseRefName: "main", state: "merged" }),
        pr(2, { headRefName: "b", baseRefName: "a" }),
        pr(3, { headRefName: "c", baseRefName: "b" }),
      ]);

      const stack = asStack(filterPrRepoGroups(groups, isOpen)[0].blocks[0]);
      expect(numbers(stack.layers)).toEqual([2, 3]);
      expect(stack.size).toBe(3);
      expect(formatPrStackCount(stack)).toBe("2 of 3");
    });

    it("drops a stack and a repo group with nothing left to show", () => {
      const groups = groupPrItemsByRepo([
        pr(1, { headRefName: "a", baseRefName: "main", state: "merged" }),
        pr(2, { headRefName: "b", baseRefName: "a", state: "closed" }),
        item({
          base: { owner: "acme", repo: "widget", prNumber: 9 },
          repoIdentifier: { owner: "acme", repo: "widget" },
          headRefName: "solo",
        }),
      ]);

      const visible = filterPrRepoGroups(groups, isOpen);
      expect(visible).toHaveLength(1);
      expect(visible[0].repoIdentifier).toEqual({
        owner: "acme",
        repo: "widget",
      });
      expect(visible[0].blocks.map((block) => block.kind)).toEqual(["single"]);
    });
  });

  describe("prStackRailEntries", () => {
    it("lists a native stack top first with absent runs where they sit", () => {
      const stack = asStack(
        onlyBlocks([
          pr(1, { stack: nativeStack(1, 6) }),
          pr(3, { stack: nativeStack(3, 6) }),
          pr(4, { stack: nativeStack(4, 6) }),
        ]).at(0),
      );

      expect(
        prStackRailEntries(stack).map((entry) =>
          entry.kind === "layer"
            ? entry.item.base?.prNumber
            : `absent:${entry.count}`,
        ),
      ).toEqual(["absent:2", 4, 3, "absent:1", 1]);
    });

    it("spans the highest size and position its rows report", () => {
      // A stack that grew after one row's fact was fetched: the stale row
      // says size 2, the newer one sits at position 3 of 3.
      const stack = asStack(
        onlyBlocks([
          pr(1, { stack: nativeStack(1, 2) }),
          pr(3, { stack: nativeStack(3, 3) }),
        ]).at(0),
      );

      expect(stack.size).toBe(3);
      expect(stack.absentPositions).toEqual([2]);
      expect(
        prStackRailEntries(stack).map((entry) =>
          entry.kind === "layer" ? entry.item.base?.prNumber : "absent",
        ),
      ).toEqual([3, "absent", 1]);
    });

    it("keeps a layer hidden by a filter off the rail without calling it absent", () => {
      // Hiding position 2 of a complete two-layer stack leaves one layer,
      // not a layer plus a "not in this task" run above it.
      const groups = groupPrItemsByRepo([
        pr(1, { stack: nativeStack(1, 2) }),
        pr(2, { stack: nativeStack(2, 2), state: "merged" }),
      ]);
      const stack = asStack(
        filterPrRepoGroups(groups, (row) => row.state === "open")[0].blocks[0],
      );

      expect(stack.absentPositions).toEqual([]);
      expect(
        prStackRailEntries(stack).map((entry) =>
          entry.kind === "layer" ? entry.item.base?.prNumber : "absent",
        ),
      ).toEqual([1]);
    });

    it("lists an inferred stack top first with no absent runs", () => {
      const stack = asStack(
        onlyBlocks([
          pr(1, { headRefName: "a", baseRefName: "main" }),
          pr(2, { headRefName: "b", baseRefName: "a" }),
        ]).at(0),
      );

      expect(stack.number).toBeNull();
      expect(prStackRailEntries(stack).map((entry) => entry.kind)).toEqual([
        "layer",
        "layer",
      ]);
      expect(
        numbers(
          prStackRailEntries(stack).flatMap((entry) =>
            entry.kind === "layer" ? [entry.item] : [],
          ),
        ),
      ).toEqual([2, 1]);
    });
  });

  describe("formatPrStackCount", () => {
    it("is just the size when every layer is present", () => {
      const stack = asStack(
        onlyBlocks([
          pr(1, { stack: nativeStack(1, 2) }),
          pr(2, { stack: nativeStack(2, 2) }),
        ]).at(0),
      );

      expect(formatPrStackCount(stack)).toBe("2");
    });
  });
});
