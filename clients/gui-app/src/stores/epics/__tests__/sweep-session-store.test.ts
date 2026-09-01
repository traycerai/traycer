import { beforeEach, describe, expect, it } from "vitest";
import {
  useSweepSessionStore,
  type ParkedSweepReview,
} from "@/stores/epics/sweep-session-store";
import type { SweepReviewSnapshot } from "@/lib/epics/sweep-consequences";

/**
 * A minimal, valid review - the tests below care about identity (is THIS the
 * review that comes back out) and never about its contents.
 */
function fakeReview(path: string): ParkedSweepReview {
  const snapshot: SweepReviewSnapshot = {
    paths: [path],
    unproven: [],
    inUse: [],
    shared: [],
    all: [],
    disclosedHolders: [],
    branchNames: [],
    pendingUncertain: [],
    retryableFailed: [],
  };
  return { snapshot, outcomes: new Map() };
}

describe("useSweepSessionStore", () => {
  beforeEach(() => {
    useSweepSessionStore.getState().reset();
  });

  it("tracks proving per session key, independently", () => {
    const store = useSweepSessionStore.getState();
    store.beginProving("host:a\nepic-1");

    expect(useSweepSessionStore.getState().proving.has("host:a\nepic-1")).toBe(
      true,
    );
    // A different session's flag is untouched by another session's begin.
    expect(useSweepSessionStore.getState().proving.has("host:b\nepic-1")).toBe(
      false,
    );

    store.endProving("host:a\nepic-1");
    expect(useSweepSessionStore.getState().proving.has("host:a\nepic-1")).toBe(
      false,
    );
  });

  it("endProving on a session that was never begun is a no-op", () => {
    useSweepSessionStore.getState().endProving("host:a\nepic-1");

    expect(useSweepSessionStore.getState().proving.size).toBe(0);
  });

  it("take returns the parked review exactly once, then null", () => {
    const review = fakeReview("/wt/a");
    useSweepSessionStore.getState().park("host:a\nepic-1", review);

    expect(useSweepSessionStore.getState().parked.has("host:a\nepic-1")).toBe(
      true,
    );

    const taken = useSweepSessionStore.getState().take("host:a\nepic-1");
    expect(taken).toBe(review);
    expect(useSweepSessionStore.getState().parked.has("host:a\nepic-1")).toBe(
      false,
    );

    // Exactly-once: a second take on the same key finds nothing left.
    expect(useSweepSessionStore.getState().take("host:a\nepic-1")).toBeNull();
  });

  it("take on a session with nothing parked returns null", () => {
    expect(
      useSweepSessionStore.getState().take("host:none\nepic-1"),
    ).toBeNull();
  });

  it("park overwrites an earlier, unclaimed review for the same session", () => {
    const first = fakeReview("/wt/first");
    const second = fakeReview("/wt/second");
    const store = useSweepSessionStore.getState();
    store.park("host:a\nepic-1", first);
    store.park("host:a\nepic-1", second);

    expect(useSweepSessionStore.getState().take("host:a\nepic-1")).toBe(second);
  });

  it("tracks which sessions have an open dialog, independently", () => {
    const store = useSweepSessionStore.getState();
    store.setOpen("host:a\nepic-1", true);

    expect(useSweepSessionStore.getState().open.has("host:a\nepic-1")).toBe(
      true,
    );
    expect(useSweepSessionStore.getState().open.has("host:b\nepic-1")).toBe(
      false,
    );

    store.setOpen("host:a\nepic-1", false);
    expect(useSweepSessionStore.getState().open.has("host:a\nepic-1")).toBe(
      false,
    );
  });

  it("reset clears proving, parked, and open together", () => {
    const store = useSweepSessionStore.getState();
    store.beginProving("host:a\nepic-1");
    store.park("host:a\nepic-1", fakeReview("/wt/a"));
    store.setOpen("host:a\nepic-1", true);

    store.reset();

    const state = useSweepSessionStore.getState();
    expect(state.proving.size).toBe(0);
    expect(state.parked.size).toBe(0);
    expect(state.open.size).toBe(0);
  });
});
