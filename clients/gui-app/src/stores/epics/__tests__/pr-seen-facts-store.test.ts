import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultPrSeenFactsScopeState,
  prSeenFactsScopeKey,
  selectPrHasChangedDot,
  selectPrScopeHasItems,
  selectPrSeenFactsScope,
  usePrSeenFactsStore,
  type PrSeenFactsScopeState,
} from "@/stores/epics/pr-seen-facts-store";
import type { PrSeenFact } from "@/lib/pr/pr-changed-dot";

const HOST_A = "host-a";
const HOST_B = "host-b";
const EPIC = "epic-1";
const OTHER_EPIC = "epic-2";

const SAMPLE_FACTS: Readonly<Record<string, PrSeenFact>> = {
  "id|github.com|acme|app|1": {
    state: "open",
    checks: { success: 1, failure: 0, pending: 0, total: 1 },
    commentCount: 0,
  },
};

function resetStore(): void {
  usePrSeenFactsStore.setState({ stateByScopeKey: {} });
}

describe("usePrSeenFactsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("scopes baselines per (hostId, epicId) — no cross-host mixing", () => {
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
    usePrSeenFactsStore.getState().markChanged(HOST_A, EPIC);

    const scopeA = selectPrSeenFactsScope(
      HOST_A,
      EPIC,
    )(usePrSeenFactsStore.getState());
    const scopeB = selectPrSeenFactsScope(
      HOST_B,
      EPIC,
    )(usePrSeenFactsStore.getState());

    expect(scopeA.seeded).toBe(true);
    expect(scopeA.hasChanged).toBe(true);
    expect(scopeA.factsByPrKey).toEqual(SAMPLE_FACTS);

    expect(scopeB).toEqual(defaultPrSeenFactsScopeState);
    expect(
      selectPrHasChangedDot(HOST_B, EPIC)(usePrSeenFactsStore.getState()),
    ).toBe(false);
    expect(
      selectPrHasChangedDot(HOST_A, EPIC)(usePrSeenFactsStore.getState()),
    ).toBe(true);
    expect(prSeenFactsScopeKey(HOST_A, EPIC)).not.toBe(
      prSeenFactsScopeKey(HOST_B, EPIC),
    );

    // Same host, a DIFFERENT epic: a scope key built from hostId alone
    // (accidentally dropping epicId) would pass every assertion above while
    // still mixing these two scopes together.
    const otherEpicScope = selectPrSeenFactsScope(
      HOST_A,
      OTHER_EPIC,
    )(usePrSeenFactsStore.getState());
    expect(otherEpicScope).toEqual(defaultPrSeenFactsScopeState);
    expect(
      selectPrHasChangedDot(HOST_A, OTHER_EPIC)(usePrSeenFactsStore.getState()),
    ).toBe(false);
    expect(prSeenFactsScopeKey(HOST_A, EPIC)).not.toBe(
      prSeenFactsScopeKey(HOST_A, OTHER_EPIC),
    );
  });

  it("seedBaseline is silent (seeded, hasChanged false)", () => {
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
    const scope = selectPrSeenFactsScope(
      HOST_A,
      EPIC,
    )(usePrSeenFactsStore.getState());
    expect(scope.seeded).toBe(true);
    expect(scope.hasChanged).toBe(false);
  });

  it("clearChanged turns the flag off; markChanged turns it on", () => {
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
    usePrSeenFactsStore.getState().markChanged(HOST_A, EPIC);
    expect(
      selectPrHasChangedDot(HOST_A, EPIC)(usePrSeenFactsStore.getState()),
    ).toBe(true);
    usePrSeenFactsStore.getState().clearChanged(HOST_A, EPIC);
    expect(
      selectPrHasChangedDot(HOST_A, EPIC)(usePrSeenFactsStore.getState()),
    ).toBe(false);
  });

  it("advanceBaseline updates facts without forcing hasChanged", () => {
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
    const next: Readonly<Record<string, PrSeenFact>> = {
      "id|github.com|acme|app|1": {
        state: "merged",
        checks: { success: 1, failure: 0, pending: 0, total: 1 },
        commentCount: 2,
      },
    };
    usePrSeenFactsStore.getState().advanceBaseline(HOST_A, EPIC, next);
    const scope: PrSeenFactsScopeState = selectPrSeenFactsScope(
      HOST_A,
      EPIC,
    )(usePrSeenFactsStore.getState());
    expect(scope.factsByPrKey).toEqual(next);
    expect(scope.hasChanged).toBe(false);
  });

  describe("selectPrScopeHasItems", () => {
    it("is false for a scope that has never been observed", () => {
      expect(
        selectPrScopeHasItems(HOST_A, EPIC)(usePrSeenFactsStore.getState()),
      ).toBe(false);
    });

    it("is false with no host", () => {
      usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
      expect(
        selectPrScopeHasItems(null, EPIC)(usePrSeenFactsStore.getState()),
      ).toBe(false);
    });

    it("is true once a PR has been seen for the scope", () => {
      usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
      expect(
        selectPrScopeHasItems(HOST_A, EPIC)(usePrSeenFactsStore.getState()),
      ).toBe(true);
    });

    it("does not leak across hosts", () => {
      usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
      expect(
        selectPrScopeHasItems(HOST_B, EPIC)(usePrSeenFactsStore.getState()),
      ).toBe(false);
    });

    it("goes back to false when the epic's last PR stops being derived", () => {
      // The baseline is rebuilt from the whole list on every advance, so a PR
      // that leaves the epic drops out - the panel must hide again rather
      // than stay in the rail on a stale count.
      usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, SAMPLE_FACTS);
      usePrSeenFactsStore.getState().advanceBaseline(HOST_A, EPIC, {});
      expect(
        selectPrScopeHasItems(HOST_A, EPIC)(usePrSeenFactsStore.getState()),
      ).toBe(false);
    });
  });
});
