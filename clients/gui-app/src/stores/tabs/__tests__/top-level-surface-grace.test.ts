import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  getTopLevelSurfaceGraceKeys,
  resetTopLevelSurfaceGraceForTesting,
  subscribeTopLevelSurfaceGrace,
} from "@/stores/tabs/top-level-surface-grace";

const GRACE_MS = MOBILE_RETENTION_PROFILE.topLevelSurfaceGraceMs;
const A: TabRef = { kind: "epic", id: "a" };
const B: TabRef = { kind: "epic", id: "b" };
const C: TabRef = { kind: "draft", id: "c" };
const REFS = [A, B, C];

function activate(ref: TabRef | null): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: REFS.map((candidate) => ({
      kind: "tab" as const,
      id: `tab:${candidate.kind}:${candidate.id}`,
      ref: candidate,
    })),
    activeItemId: ref === null ? null : `tab:${ref.kind}:${ref.id}`,
    stripOrder: REFS,
  }));
}

function graceKeys(): ReadonlyArray<string> {
  return [...getTopLevelSurfaceGraceKeys()];
}

describe("top-level surface grace ledger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    activate(A);
    resetTopLevelSurfaceGraceForTesting();
  });

  afterEach(() => {
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    resetTopLevelSurfaceGraceForTesting();
    vi.useRealTimers();
  });

  it("holds the surface just left until the profile's grace ends, then notifies", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTopLevelSurfaceGrace(listener);

    activate(B);
    expect(graceKeys()).toEqual(["epic:a"]);
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(graceKeys()).toEqual(["epic:a"]);

    vi.advanceTimersByTime(1);
    expect(graceKeys()).toEqual([]);
    // The expiry is an update readers can see, not a value they would have to
    // re-derive from a clock.
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("holds only the LAST departure: stepping through three surfaces keeps one extra", () => {
    activate(B);
    activate(C);

    expect(graceKeys()).toEqual(["epic:b"]);
  });

  it("restarts the window for each departure rather than keeping the first one's deadline", () => {
    activate(B);
    vi.advanceTimersByTime(GRACE_MS - 1_000);
    activate(C);

    vi.advanceTimersByTime(1_000);
    expect(graceKeys()).toEqual(["epic:b"]);

    vi.advanceTimersByTime(GRACE_MS - 1_000);
    expect(graceKeys()).toEqual([]);
  });

  it("drops a surface from its grace once it is active again", () => {
    activate(B);
    activate(A);

    // A is active (retained as active); B is the one just left.
    expect(graceKeys()).toEqual(["epic:b"]);
  });

  it("ends a grace early when its surface joins the active set with nothing leaving it", () => {
    activate(B);
    expect(graceKeys()).toEqual(["epic:a"]);

    // B stays active and A joins it in a split: no departure, so nothing
    // replaces the grace set - A has to leave it because it is active now.
    useTabsStore.setState((state) => ({
      ...state,
      items: [
        {
          kind: "split",
          id: "pair",
          left: { kind: "tab", ref: B },
          right: { kind: "tab", ref: A },
          focusedSide: "right",
          routeBackingSide: "right",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "pair",
      stripOrder: [B, A],
    }));

    expect(graceKeys()).toEqual([]);
  });

  it("does not move on a store change that leaves the active set alone", () => {
    activate(B);
    const before = getTopLevelSurfaceGraceKeys();

    useTabsStore.setState((state) => ({ ...state }));

    expect(getTopLevelSurfaceGraceKeys()).toBe(before);
  });

  it("keeps nothing on the desktop profile", () => {
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);

    activate(B);

    expect(DESKTOP_RETENTION_PROFILE.topLevelSurfaceGraceMs).toBe(0);
    expect(graceKeys()).toEqual([]);
  });
});
