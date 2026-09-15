import { beforeEach, describe, expect, it } from "vitest";
import {
  selectLandingReceipt,
  useLandingReceiptsStore,
  type LandingReceipt,
} from "@/stores/onboarding/landing-receipts-store";

function receipt(attemptId: string): LandingReceipt {
  return {
    kind: "prompt-accepted",
    attemptId,
    draftId: `draft-${attemptId}`,
    epicId: `epic-${attemptId}`,
    tabId: `tab-${attemptId}`,
    hostId: "host-a",
  };
}

beforeEach(() => {
  useLandingReceiptsStore.getState().reset();
});

describe("landing receipts store", () => {
  it("keeps the first receipt for an attempt (duplicate emit is idempotent)", () => {
    const store = useLandingReceiptsStore.getState();
    const generation = store.announce({
      kind: "prompt-accepted",
      attemptId: "a",
      draftId: "draft-a",
      hostId: "host-a",
    });
    store.emit(receipt("a"), generation);
    const before = useLandingReceiptsStore.getState().byAttemptId;
    store.emit({ ...receipt("a"), epicId: "epic-other" }, generation);
    expect(useLandingReceiptsStore.getState().byAttemptId).toBe(before);
    expect(
      selectLandingReceipt(useLandingReceiptsStore.getState(), "a"),
    ).toEqual(receipt("a"));
  });

  it("consume hands the receipt out exactly once and drops its dispatch", () => {
    const store = useLandingReceiptsStore.getState();
    const generation = store.announce({
      kind: "prompt-accepted",
      attemptId: "a",
      draftId: "draft-a",
      hostId: "host-a",
    });
    store.emit(receipt("a"), generation);
    expect(store.consume("a")).toEqual(receipt("a"));
    expect(store.consume("a")).toBeNull();
    expect(useLandingReceiptsStore.getState().dispatchedByAttemptId).toEqual(
      {},
    );
    expect(selectLandingReceipt(useLandingReceiptsStore.getState(), null)).toBe(
      undefined,
    );
  });

  it("is bounded: unrelated creates evict the oldest, never a newer relevant one", () => {
    const store = useLandingReceiptsStore.getState();
    const generation = useLandingReceiptsStore.getState().generation;
    for (let index = 0; index < 12; index += 1) {
      store.emit(receipt(`r${index}`), generation);
    }
    const kept = Object.keys(useLandingReceiptsStore.getState().byAttemptId);
    expect(kept).toHaveLength(8);
    expect(kept[0]).toBe("r4");
    expect(kept[7]).toBe("r11");
  });

  it("reset clears receipts and dispatches, bumps the generation, keeps the dispatch sequence", () => {
    const store = useLandingReceiptsStore.getState();
    const generation = store.announce({
      kind: "tui-accepted",
      attemptId: "t",
      draftId: null,
      hostId: "host-a",
    });
    store.emit(receipt("t"), generation);
    const sequence = useLandingReceiptsStore.getState().dispatchSequence;
    store.reset();
    expect(useLandingReceiptsStore.getState().byAttemptId).toEqual({});
    expect(useLandingReceiptsStore.getState().dispatchedByAttemptId).toEqual(
      {},
    );
    expect(useLandingReceiptsStore.getState().dispatchSequence).toBe(sequence);
    expect(useLandingReceiptsStore.getState().generation).toBe(generation + 1);
  });

  it("drops an emit whose generation predates a reset (a create resolving after sign-out/replay)", () => {
    const store = useLandingReceiptsStore.getState();
    const generation = store.announce({
      kind: "tui-accepted",
      attemptId: "late",
      draftId: null,
      hostId: "host-a",
    });
    store.reset();
    store.emit(receipt("late"), generation);
    expect(useLandingReceiptsStore.getState().byAttemptId).toEqual({});
    // The next identity's own attempt still lands.
    const next = store.announce({
      kind: "prompt-accepted",
      attemptId: "fresh",
      draftId: "draft-fresh",
      hostId: "host-b",
    });
    store.emit(receipt("fresh"), next);
    expect(Object.keys(useLandingReceiptsStore.getState().byAttemptId)).toEqual(
      ["fresh"],
    );
  });

  it("retire drops the dispatch (a waiter stops waiting) and leaves any receipt alone", () => {
    const store = useLandingReceiptsStore.getState();
    store.announce({
      kind: "prompt-accepted",
      attemptId: "r",
      draftId: "draft-r",
      hostId: "host-a",
    });
    store.retire("r");
    expect(useLandingReceiptsStore.getState().dispatchedByAttemptId).toEqual(
      {},
    );
    store.retire("r");
    expect(useLandingReceiptsStore.getState().byAttemptId).toEqual({});
  });
});
