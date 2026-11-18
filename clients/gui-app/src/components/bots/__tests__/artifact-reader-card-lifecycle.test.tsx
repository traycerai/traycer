/**
 * What makes the artifact reference card's reader exist, and what ends it:
 * a worker fatal, capacity that is gone when the reader materialises, and
 * presentation (scrolled out, raised in a hidden pane, no IntersectionObserver).
 * Real card, real controller token, real tab commands.
 */
import userEvent from "@testing-library/user-event";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pane = vi.hoisted(() => {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    get: (): boolean => visible,
    set: (next: boolean): void => {
      visible = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

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
  async (importOriginal) => {
    const { useSyncExternalStore } = await import("react");
    return {
      ...(await importOriginal<
        typeof import("@/components/epic-tabs/pane-visibility-context")
      >()),
      usePaneVisible: () =>
        useSyncExternalStore(pane.subscribe, pane.get, pane.get),
      usePaneFocused: () => true,
      usePaneFocusProbe: () => () => true,
    };
  },
);

import {
  EPIC_ID,
  HOST_ID,
  SURFACE,
  admittedHandle,
  deliverSnapshot,
  installReaderCardHarness,
  intersectAll,
  intersectIn,
  firstToken,
  killLatestWorker,
  openShownTabs,
  mountCard,
  observedCardCount,
  seen,
  showCardAlone,
  type ArtifactSurface,
} from "@/components/bots/__tests__/artifact-reader-card-harness-support";
import { SHOW_PREVIEW_COPY } from "@/components/chat/segments/artifact-row";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { setTestEffectiveHost } from "@/lib/registries/test-support/epic-session-controller-test-support";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { DEFAULT_MAX_LIVE_EPICS } from "@/stores/replica-memory/budget-limits";

installReaderCardHarness();

/** The card admitted over a delivered snapshot and showing its frame, no tab. */
async function showReaderOnlyCard(): Promise<RenderResult> {
  const view = await showCardAlone(SURFACE, "row-1");
  deliverSnapshot();
  await screen.findByTestId("artifact-frame-driver");
  return view;
}

describe("a runtime fatal under a ready reader", () => {
  it("moves it to failed at once, builds nothing on unrelated churn, and Retry gives a new handle", async () => {
    await showReaderOnlyCard();
    const token = firstToken();
    const handle = admittedHandle();
    expect(token.read().kind).toBe("ready");

    killLatestWorker();

    expect(token.read().kind).toBe("failed");
    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();
    const constructionsBefore = seen.constructions;
    act(() => {
      useEpicCanvasStore.setState((state) => ({ ...state }));
      setTestEffectiveHost(HOST_ID, true);
    });
    expect(seen.constructions).toBe(constructionsBefore);

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(seen.constructions).toBe(constructionsBefore + 1),
    );
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBe(handle);
  });
});

describe("a presented card's session under tab pressure", () => {
  it("a presented card's session survives a tab acquisition over the cap", async () => {
    await showReaderOnlyCard();
    const handle = admittedHandle();
    const disposeHandle = vi.spyOn(handle, "dispose");
    const token = firstToken();
    expect(token.read().kind).toBe("ready");

    // The cap is filled by shown tabs of other tasks; one more tab then runs
    // the warm-cap prune over it.
    openShownTabs(DEFAULT_MAX_LIVE_EPICS, "other");
    openShownTabs(1, "one-more");

    expect(disposeHandle).not.toHaveBeenCalled();
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBe(handle);
    expect(screen.getByTestId("artifact-frame-driver")).toBeTruthy();
    expect(token.read().kind).toBe("ready");
  });
});

describe("a presented card over a full cap", () => {
  it("constructs over the cap like a tab, shows its frame, and is pruned as an ordinary warm session the moment it scrolls out", async () => {
    openShownTabs(DEFAULT_MAX_LIVE_EPICS, "other");
    const constructionsAtCap = seen.constructions;
    expect(constructionsAtCap).toBe(DEFAULT_MAX_LIVE_EPICS);

    const view = mountCard(SURFACE, "row-1");
    intersectAll(true);
    await waitFor(() =>
      expect(seen.constructions).toBe(constructionsAtCap + 1),
    );
    deliverSnapshot();

    await screen.findByTestId("artifact-frame-driver");
    expect(firstToken().read().kind).toBe("ready");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    const handle = admittedHandle();
    const disposeHandle = vi.spyOn(handle, "dispose");

    // Scrolled out, the card holds nothing: its handle is warm over a full
    // cap, so the release itself prunes it.
    intersectIn(view.container, false);

    expect(__getOpenEpicRegistryForTests().hasReaderDemand(EPIC_ID)).toBe(
      false,
    );
    expect(disposeHandle).toHaveBeenCalledTimes(1);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();
  });
});

describe("a card is demand only while it is presented", () => {
  it("scrolling out releases the reader, and coming back reuses the warm session", async () => {
    const view = await showReaderOnlyCard();
    const registry = __getOpenEpicRegistryForTests();
    const handle = admittedHandle();
    const constructionsBefore = seen.constructions;
    expect(registry.hasReaderDemand(EPIC_ID)).toBe(true);

    intersectIn(view.container, false);

    expect(registry.hasReaderDemand(EPIC_ID)).toBe(false);
    expect(screen.queryByTestId("artifact-frame-driver")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in panel" })).toBeNull();
    // The row keeps its place: the figure is still there, with no content.
    expect(screen.getByTestId("artifact-row")).toBeTruthy();

    intersectIn(view.container, true);

    await waitFor(() => expect(registry.hasReaderDemand(EPIC_ID)).toBe(true));
    expect(seen.constructions).toBe(constructionsBefore);
    expect(registry.peek(EPIC_ID)).toBe(handle);
  });

  it("five cards that were never in view do not block a visible sixth", async () => {
    const offscreen: ArtifactSurface[] = Array.from(
      { length: DEFAULT_MAX_LIVE_EPICS },
      (_, index) => ({ ...SURFACE, epicId: `elsewhere-${String(index)}` }),
    );
    offscreen.forEach((surface, index) =>
      mountCard(surface, `row-offscreen-${String(index)}`),
    );
    // None was presented, so none acquired anything.
    expect(seen.tokens).toHaveLength(0);
    expect(seen.constructions).toBe(0);

    const visible = mountCard(SURFACE, "row-visible");
    intersectIn(visible.container, true);
    await waitFor(() => expect(seen.constructions).toBe(1));
    deliverSnapshot();

    await within(visible.container).findByTestId("artifact-frame-driver");
    expect(observedCardCount()).toBeGreaterThanOrEqual(
      DEFAULT_MAX_LIVE_EPICS + 1,
    );
  });

  it("a raised card in a hidden pane holds no demand, and holds it again when the pane returns", async () => {
    const view = await showReaderOnlyCard();
    const registry = __getOpenEpicRegistryForTests();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Raised, it is presented even once its row has scrolled away.
    intersectIn(view.container, false);
    expect(registry.hasReaderDemand(EPIC_ID)).toBe(true);

    act(() => pane.set(false));

    expect(registry.hasReaderDemand(EPIC_ID)).toBe(false);

    act(() => pane.set(true));
    await waitFor(() => expect(registry.hasReaderDemand(EPIC_ID)).toBe(true));
  });

  it("without IntersectionObserver acquires nothing on its own and offers an explicit button", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);

    mountCard(SURFACE, "row-1");

    expect(seen.tokens).toHaveLength(0);
    expect(seen.constructions).toBe(0);
    const show = screen.getByRole("button", { name: SHOW_PREVIEW_COPY });

    await userEvent.setup().click(show);

    await waitFor(() => expect(seen.tokens).toHaveLength(1));
    expect(seen.constructions).toBe(1);
  });
});
