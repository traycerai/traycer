import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultPrSeenFactsScopeState,
  prSeenFactsScopeKey,
  selectPrHasChangedDot,
  selectPrSeenFactsScope,
  usePrSeenFactsStore,
  type PrSeenFactsScopeState,
} from "@/stores/epics/pr-seen-facts-store";
import type { PrSeenFact } from "@/lib/pr/pr-changed-dot";

const HOST_A = "host-a";
const HOST_B = "host-b";
const EPIC = "epic-1";

const sampleFacts: Readonly<Record<string, PrSeenFact>> = {
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
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, sampleFacts);
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
    expect(scopeA.factsByPrKey).toEqual(sampleFacts);

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
  });

  it("seedBaseline is silent (seeded, hasChanged false)", () => {
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, sampleFacts);
    const scope = selectPrSeenFactsScope(
      HOST_A,
      EPIC,
    )(usePrSeenFactsStore.getState());
    expect(scope.seeded).toBe(true);
    expect(scope.hasChanged).toBe(false);
  });

  it("clearChanged turns the flag off; markChanged turns it on", () => {
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, sampleFacts);
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
    usePrSeenFactsStore.getState().seedBaseline(HOST_A, EPIC, sampleFacts);
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
});
