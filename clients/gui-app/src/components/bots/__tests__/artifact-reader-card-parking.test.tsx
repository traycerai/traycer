/**
 * A presented artifact card is a way an epic is visible, so it joins epic
 * parking's window: it cancels or undoes a park, and when the last presented
 * reader leaves the existing park path reclaims the session a window later.
 * Real card, real controller token, real park deadline on a fake clock; what is
 * asserted is the ACTUAL reclaim (handle disposed, stream closed, registry empty).
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  detachTaskSurfaces,
  firstToken,
  installReaderCardHarness,
  intersectAll,
  mountCard,
  openShownTaskTab,
  seen,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import { isEpicParked } from "@/lib/epics/epic-parking";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { seedLocalRootEdit } from "@/lib/registries/test-support/epic-session-controller-test-support";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";

installReaderCardHarness();

afterEach(() => {
  vi.useRealTimers();
});

function peek() {
  return __getOpenEpicRegistryForTests().peek(EPIC_ID);
}

async function pastParkWindow(fraction: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS * fraction);
  });
}

/** A visible task tab; the fake clock starts BEFORE it opens, as the park deadline reads it. */
function openVisibleTab(): string {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { tabId } = openShownTaskTab();
  setEpicSurfaceVisibility(EPIC_ID, tabId, true);
  return tabId;
}

/** The tab's pane goes away: its window of visibility starts to run. */
function hideTab(tabId: string): void {
  act(() => {
    setEpicSurfaceVisibility(EPIC_ID, tabId, false);
    detachTaskSurfaces();
  });
}

describe("a card on a task whose only tab is hidden", () => {
  it("(P1) un-parks a parked task with a live handle and an open stream, and a window after it leaves the reader reclaims it", async () => {
    const tabId = openVisibleTab();
    hideTab(tabId);
    await pastParkWindow(1);
    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(peek()).toBeNull();
    const closesAtPark = seen.streamCloses;
    const subscribesAtPark = seen.subscribes;

    mountCard(SURFACE, "row-1");
    intersectAll(true);

    await waitFor(() => expect(peek()).not.toBeNull());
    expect(isEpicParked(EPIC_ID)).toBe(false);
    await waitFor(() =>
      expect(seen.subscribes).toBeGreaterThan(subscribesAtPark),
    );
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    expect(seen.streamCloses).toBe(closesAtPark);
    const handle = admittedHandle();
    const disposeHandle = vi.spyOn(handle, "dispose");

    intersectAll(false);
    await pastParkWindow(1);

    expect(peek()).toBeNull();
    expect(disposeHandle).toHaveBeenCalledTimes(1);
    expect(seen.streamCloses).toBe(closesAtPark + 1);
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });

  it("(P2) a reader arriving before the deadline keeps the task alive past it, and its leaving reclaims one window later", async () => {
    const tabId = openVisibleTab();
    hideTab(tabId);
    await pastParkWindow(0.5);

    mountCard(SURFACE, "row-1");
    intersectAll(true);
    await pastParkWindow(1);

    expect(peek()).not.toBeNull();
    expect(isEpicParked(EPIC_ID)).toBe(false);

    intersectAll(false);
    await pastParkWindow(0.5);
    expect(peek()).not.toBeNull();
    await pastParkWindow(0.5);

    expect(peek()).toBeNull();
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });

  it("(P3) a reader leaving a dirty epic reclaims it only after its work clears", async () => {
    const tabId = openVisibleTab();
    mountCard(SURFACE, "row-1");
    intersectAll(true);
    await waitFor(() => expect(seen.tokens).toHaveLength(1));
    deliverSnapshot();
    await screen.findByTestId("artifact-frame-driver");
    await seedLocalRootEdit(admittedHandle(), "title", "Unsynced work");
    hideTab(tabId);

    intersectAll(false);
    await pastParkWindow(1);

    expect(peek()).not.toBeNull();
    expect(isEpicParked(EPIC_ID)).toBe(false);

    __getOpenEpicRegistryForTests().drainUnsyncedEdits(EPIC_ID);
    await pastParkWindow(1);

    expect(peek()).toBeNull();
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });

  it("(P4) a card whose reader is refused does not hold parking off", async () => {
    const tabId = openVisibleTab();
    hideTab(tabId);
    // The task is bound to this window's host; the card names another one, so
    // its reader is refused and was never a way the task is shown.
    mountCard({ ...SURFACE, hostId: "host-elsewhere" }, "row-1");
    intersectAll(true);
    await waitFor(() => expect(seen.tokens).toHaveLength(1));
    expect(seen.tokens[0]?.read().kind).toBe("refused");

    await pastParkWindow(1);

    expect(peek()).toBeNull();
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });

  it("(P5) a refused card scrolling in does not un-park an already parked task", async () => {
    const tabId = openVisibleTab();
    hideTab(tabId);
    await pastParkWindow(1);
    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(peek()).toBeNull();

    // The task's host is this window's; the card names another, so it is
    // refused and is no way the task is shown.
    mountCard({ ...SURFACE, hostId: "host-elsewhere" }, "row-1");
    intersectAll(true);
    await waitFor(() => expect(seen.tokens).toHaveLength(1));
    expect(firstToken().read()).toMatchObject({
      kind: "refused",
      reason: "host-conflict",
    });

    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(peek()).toBeNull();
  });

  it("(P6) a refused card scrolling in and out does not restart the park window", async () => {
    const tabId = openVisibleTab();
    hideTab(tabId);
    await pastParkWindow(0.5);

    mountCard({ ...SURFACE, hostId: "host-elsewhere" }, "row-1");
    intersectAll(true);
    await waitFor(() => expect(seen.tokens).toHaveLength(1));
    expect(firstToken().read().kind).toBe("refused");
    intersectAll(false);
    await pastParkWindow(0.5);

    // Parked at the original deadline, not a full window after the card left.
    expect(peek()).toBeNull();
    expect(isEpicParked(EPIC_ID)).toBe(true);
  });
});
