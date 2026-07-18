import { describe, expect, it } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import {
  buildPrSeenFactsMap,
  evaluatePrListAgainstBaseline,
  isChecksDeltaDotWorthy,
  isPrFactDotWorthy,
  prSeenFactKey,
  toPrSeenFact,
  type PrSeenFact,
} from "@/lib/pr/pr-changed-dot";

const DEFAULT_ITEM: PrLightItem = {
  githubHost: "github.com",
  base: { owner: "acme", repo: "app", prNumber: 1 },
  prUrl: "https://github.com/acme/app/pull/1",
  state: "open",
  liveness: "live",
  observedAt: 1_000,
  isDraft: false,
  title: "feat",
  baseRefName: "main",
  headRefName: "feature",
  additions: 1,
  deletions: 0,
  checksRollup: { success: 2, failure: 0, pending: 0, total: 2 },
  reviewDecision: null,
  commentCount: 1,
  updatedAt: 1_000,
  repoIdentifier: { owner: "acme", repo: "app" },
  owners: [],
};

function makeItem(overrides: Partial<PrLightItem>): PrLightItem {
  return { ...DEFAULT_ITEM, ...overrides };
}

function fact(overrides: Partial<PrSeenFact>): PrSeenFact {
  return {
    state: overrides.state ?? "open",
    checks: Object.hasOwn(overrides, "checks")
      ? (overrides.checks as PrSeenFact["checks"])
      : { success: 2, failure: 0, pending: 0, total: 2 },
    commentCount: Object.hasOwn(overrides, "commentCount")
      ? (overrides.commentCount as number | null)
      : 1,
  };
}

describe("isPrFactDotWorthy — state", () => {
  it("lights when state changes", () => {
    expect(
      isPrFactDotWorthy(fact({ state: "open" }), fact({ state: "merged" })),
    ).toBe(true);
  });

  it("does not light when state is unchanged", () => {
    expect(
      isPrFactDotWorthy(fact({ state: "open" }), fact({ state: "open" })),
    ).toBe(false);
  });
});

describe("isPrFactDotWorthy — comments", () => {
  it("lights when comment count increases", () => {
    expect(
      isPrFactDotWorthy(fact({ commentCount: 2 }), fact({ commentCount: 3 })),
    ).toBe(true);
  });

  it("does not light when comment count decreases", () => {
    expect(
      isPrFactDotWorthy(fact({ commentCount: 3 }), fact({ commentCount: 2 })),
    ).toBe(false);
  });

  it("does not light when comment count is unchanged", () => {
    expect(
      isPrFactDotWorthy(fact({ commentCount: 2 }), fact({ commentCount: 2 })),
    ).toBe(false);
  });

  it("does not light when comment count first appears (null → N)", () => {
    expect(
      isPrFactDotWorthy(
        fact({ commentCount: null }),
        fact({ commentCount: 4 }),
      ),
    ).toBe(false);
  });
});

describe("isChecksDeltaDotWorthy", () => {
  it("lights when a check concludes as failure (failure↑)", () => {
    expect(
      isChecksDeltaDotWorthy(
        { success: 2, failure: 0, pending: 1, total: 3 },
        { success: 2, failure: 1, pending: 0, total: 3 },
      ),
    ).toBe(true);
  });

  it("lights when a check concludes as success (success↑)", () => {
    expect(
      isChecksDeltaDotWorthy(
        { success: 1, failure: 0, pending: 1, total: 2 },
        { success: 2, failure: 0, pending: 0, total: 2 },
      ),
    ).toBe(true);
  });

  it("lights when overall result flips fail → pass (failure cleared)", () => {
    expect(
      isChecksDeltaDotWorthy(
        { success: 1, failure: 1, pending: 0, total: 2 },
        { success: 2, failure: 0, pending: 0, total: 2 },
      ),
    ).toBe(true);
  });

  it("does NOT light when a check merely starts (pending↑ only)", () => {
    expect(
      isChecksDeltaDotWorthy(
        { success: 2, failure: 0, pending: 0, total: 2 },
        { success: 2, failure: 0, pending: 1, total: 3 },
      ),
    ).toBe(false);
  });

  it("does NOT light when rollup first appears (null → data)", () => {
    expect(
      isChecksDeltaDotWorthy(null, {
        success: 1,
        failure: 0,
        pending: 0,
        total: 1,
      }),
    ).toBe(false);
  });

  it("does NOT light when rollup is unchanged", () => {
    const rollup = { success: 2, failure: 0, pending: 0, total: 2 };
    expect(isChecksDeltaDotWorthy(rollup, { ...rollup })).toBe(false);
  });
});

describe("evaluatePrListAgainstBaseline", () => {
  it("silent first seed: empty baseline never reports a delta", () => {
    const items = [makeItem({})];
    const result = evaluatePrListAgainstBaseline({
      baseline: {},
      items,
    });
    expect(result.hasDotWorthyDelta).toBe(false);
    expect(Object.keys(result.nextFacts)).toHaveLength(1);
  });

  it("lights on a state change for a known PR", () => {
    const open = makeItem({ state: "open" });
    const key = prSeenFactKey(open);
    const baseline = { [key]: toPrSeenFact(open) };
    const merged = makeItem({ state: "merged" });
    const result = evaluatePrListAgainstBaseline({
      baseline,
      items: [merged],
    });
    expect(result.hasDotWorthyDelta).toBe(true);
  });

  it("does not light for a brand-new PR key (first sight is a seed)", () => {
    const known = makeItem({
      base: { owner: "acme", repo: "app", prNumber: 1 },
    });
    const baseline = buildPrSeenFactsMap([known]);
    const brandNew = makeItem({
      base: { owner: "acme", repo: "app", prNumber: 2 },
      prUrl: "https://github.com/acme/app/pull/2",
      title: "other",
    });
    const result = evaluatePrListAgainstBaseline({
      baseline,
      items: [known, brandNew],
    });
    expect(result.hasDotWorthyDelta).toBe(false);
    expect(Object.keys(result.nextFacts)).toHaveLength(2);
  });

  it("does not light when only pending starts on a known PR", () => {
    const prev = makeItem({
      checksRollup: { success: 2, failure: 0, pending: 0, total: 2 },
    });
    const baseline = buildPrSeenFactsMap([prev]);
    const next = makeItem({
      checksRollup: { success: 2, failure: 0, pending: 1, total: 3 },
    });
    expect(
      evaluatePrListAgainstBaseline({ baseline, items: [next] })
        .hasDotWorthyDelta,
    ).toBe(false);
  });

  it("does not light on comment deletion", () => {
    const prev = makeItem({ commentCount: 5 });
    const baseline = buildPrSeenFactsMap([prev]);
    const next = makeItem({ commentCount: 3 });
    expect(
      evaluatePrListAgainstBaseline({ baseline, items: [next] })
        .hasDotWorthyDelta,
    ).toBe(false);
  });

  it("uses distinct keys for fully-identified vs list-only rows", () => {
    const identified = makeItem({
      githubHost: "github.com",
      base: { owner: "acme", repo: "app", prNumber: 9 },
    });
    const listOnly = makeItem({
      githubHost: null,
      base: null,
      headRefName: "fork-head",
      prUrl: null,
    });
    expect(prSeenFactKey(identified)).not.toBe(prSeenFactKey(listOnly));
    expect(prSeenFactKey(identified).startsWith("id|")).toBe(true);
    expect(prSeenFactKey(listOnly).startsWith("head|")).toBe(true);
  });
});
