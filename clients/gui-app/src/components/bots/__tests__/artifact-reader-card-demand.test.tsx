/**
 * What a presented artifact card's demand means for the session it shares: one
 * session however many cards present it, kept (never a prune candidate) while
 * any card does, ordinary warm once none does, never evicted ahead of an
 * eligible warm session, and dropped exactly once when its last card lets go
 * even if a registry listener acquires something in the middle of that.
 */
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => null,
}));
vi.mock("@/components/sandbox/sandbox-frame", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sandbox/sandbox-frame")
  >()),
  SandboxFrame: (
    await import("@/components/sandbox/__tests__/artifact-frame-browser-driver")
  ).ArtifactFrameBrowserDriver,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);

import {
  EPIC_ID,
  SURFACE,
  admittedHandle,
  deliverSnapshot,
  deliverSnapshotTo,
  installReaderCardHarness,
  intersectAll,
  intersectIn,
  mountCard,
  openShownTabs,
  presentCardOn,
  registry,
  seen,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";

installReaderCardHarness();

describe("several presented cards on one task", () => {
  it("share one session, which keeps its demand until the last one leaves", async () => {
    const first = mountCard(SURFACE, "row-1");
    const second = mountCard(SURFACE, "row-2");
    intersectAll(true);
    await waitFor(() => expect(seen.tokens).toHaveLength(2));
    deliverSnapshot();
    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-frame-driver")).toHaveLength(2),
    );
    const handle = admittedHandle();
    const disposeHandle = vi.spyOn(handle, "dispose");
    expect(seen.constructions).toBe(1);

    // One leaves: the other still presents the task.
    intersectIn(first.container, false);
    expect(registry().hasReaderDemand(EPIC_ID)).toBe(true);

    // The session is not a prune candidate: a tab acquisition over the cap
    // leaves it alone.
    openShownTabs(DEFAULT_MAX_LIVE_EPICS, "other");
    openShownTabs(1, "one-more");
    expect(disposeHandle).not.toHaveBeenCalled();
    expect(registry().peek(EPIC_ID)).toBe(handle);

    // Both gone, over a full cap: it is an ordinary warm session, so the
    // release itself prunes it.
    intersectIn(second.container, false);
    expect(registry().hasReaderDemand(EPIC_ID)).toBe(false);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
    expect(registry().peek(EPIC_ID)).toBeNull();
  });
});

describe("presented cards over a cap of warm sessions", () => {
  it("keep their own sessions while the eligible warm ones are evicted oldest first", async () => {
    // A cap's worth of clean warm sessions: cards that were presented, then left.
    const warmEpics = Array.from(
      { length: DEFAULT_MAX_LIVE_EPICS },
      (_, index) => `warm-${String(index)}`,
    );
    for (const [index, epicId] of warmEpics.entries()) {
      const view = await presentCardOn(epicId, `warm-row-${String(index)}`);
      // The session loads while its card is presented, as a real one does:
      // an unloaded session is not yet settled and is never a prune candidate.
      deliverSnapshotTo(epicId);
      intersectIn(view.container, false);
      expect(registry().hasReaderDemand(epicId)).toBe(false);
    }
    expect(registry().size()).toBe(DEFAULT_MAX_LIVE_EPICS);
    for (const epicId of warmEpics) {
      expect(registry().isEligibleForCapEviction(epicId)).toBe(true);
    }

    // A card on a new task is presented: it constructs over the cap, and the
    // oldest warm session makes room, leaving the registry at the cap.
    await presentCardOn("fresh-0", "fresh-row-0");
    expect(registry().size()).toBe(DEFAULT_MAX_LIVE_EPICS);
    expect(registry().hasReaderDemand("fresh-0")).toBe(true);
    expect(registry().peek("warm-0")).toBeNull();
    for (const epicId of warmEpics.slice(1)) {
      expect(registry().peek(epicId)).not.toBeNull();
    }

    // The next one takes the next oldest.
    await presentCardOn("fresh-1", "fresh-row-1");
    expect(registry().size()).toBe(DEFAULT_MAX_LIVE_EPICS);
    expect(registry().hasReaderDemand("fresh-0")).toBe(true);
    expect(registry().hasReaderDemand("fresh-1")).toBe(true);
    for (const epicId of warmEpics.slice(0, 2)) {
      expect(registry().peek(epicId)).toBeNull();
    }
    for (const epicId of warmEpics.slice(2)) {
      expect(registry().peek(epicId)).not.toBeNull();
    }
  });
});

describe("the last reader leaving while a listener acquires", () => {
  it("drops the released unit exactly once, and the listener's own acquisition keeps its handle", async () => {
    // One short of the cap in tabs, and the card's session at the cap.
    openShownTabs(DEFAULT_MAX_LIVE_EPICS - 1, "tab");
    const view = mountCard(SURFACE, "row-1");
    intersectAll(true);
    await waitFor(() => expect(seen.tokens).toHaveLength(1));
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    const handle = admittedHandle();
    const disposeReleased = vi.spyOn(handle, "dispose");
    // The first registry notification after the release opens a tab, in the
    // middle of the release's own bookkeeping.
    let reentered = false;
    const stop = registry().subscribe(() => {
      if (reentered || registry().hasReaderDemand(EPIC_ID)) return;
      reentered = true;
      openShownTabs(1, "reentrant");
    });
    try {
      intersectIn(view.container, false);

      expect(reentered).toBe(true);
      // The released session was the only warm one over the cap: dropped once.
      expect(disposeReleased).toHaveBeenCalledTimes(1);
      expect(registry().peek(EPIC_ID)).toBeNull();
      // The listener's acquisition kept its own handle, not disposed.
      const replacement = registry().peek("reentrant-0");
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe(handle);
      expect(registry().hasReaderDemand(EPIC_ID)).toBe(false);
      seen.tokens[0]?.release();
      seen.tokens[0]?.release();
      expect(disposeReleased).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
