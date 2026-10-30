import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { useCanvasPresentation } from "../use-canvas-presentation";
import { canvasPageItems } from "../canvas-model";
import { snapshotFromFixture, type CanvasFixtureFile } from "./canvas-fixtures";

const A = "boards/a.html";
const B = "boards/b.html";

const file: CanvasFixtureFile = {
  pages: [{ id: "page-1", name: "Flow" }],
  boards: {
    [A]: { x: 0, y: 0, w: 100, h: 100 },
    [B]: { x: 1000, y: 0, w: 100, h: 100 },
  },
  notes: {},
  order: [A, B],
};

/** The slice of `useCanvasPresentation`'s result these tests exercise. */
interface PresentationHarnessResult {
  readonly liveBoards: ReadonlySet<string>;
  readonly activeFullscreen: string | null;
  readonly setFullscreen: (path: string | null) => void;
  readonly presentationFullscreen: boolean;
}

// Built once: a fresh snapshot, size or viewport object on every render
// would give `selectLiveBoards` a new reference each time even though
// nothing changed, which the mounts hook reads as a real change and
// re-admits forever (`useCanvasPresentation`'s `useMemo` only short-circuits
// when every dependency keeps its identity, exactly as the real editor's own
// `useState`-held size/viewport do).
const snapshot = snapshotFromFixture(file);
const items = canvasPageItems(snapshot, "page-1", null);
const SIZE = { width: 800, height: 600 };
const VIEWPORT = { x: 0, y: 0, zoom: 1 };

function Harness(props: {
  readonly tabSelected: boolean;
  readonly paneVisible: boolean;
  readonly onResult: (result: PresentationHarnessResult) => void;
}) {
  const result = useCanvasPresentation({
    snapshot,
    items,
    boardByteLengths: null,
    liveSlotBudget: 2,
    size: SIZE,
    viewport: VIEWPORT,
    settledViewport: VIEWPORT,
    playingBoard: null,
  });
  props.onResult({
    liveBoards: result.liveBoards,
    activeFullscreen: result.activeFullscreen,
    setFullscreen: result.setFullscreen,
    presentationFullscreen: result.presentation.fullscreen,
  });
  return null;
}

const NOT_YET_RENDERED: PresentationHarnessResult = {
  liveBoards: new Set(),
  activeFullscreen: null,
  setFullscreen: () => {
    throw new Error("the harness has not rendered yet");
  },
  presentationFullscreen: false,
};

function renderHarness(tabSelected: boolean, paneVisible: boolean) {
  let latest: PresentationHarnessResult = NOT_YET_RENDERED;
  const capture = (result: PresentationHarnessResult): void => {
    latest = result;
  };
  const view = render(
    <PaneVisibilityContext.Provider value={paneVisible}>
      <TabBodySelectedContext.Provider value={tabSelected}>
        <Harness
          tabSelected={tabSelected}
          paneVisible={paneVisible}
          onResult={capture}
        />
      </TabBodySelectedContext.Provider>
    </PaneVisibilityContext.Provider>,
  );
  const rerender = (next: {
    readonly tabSelected: boolean;
    readonly paneVisible: boolean;
  }): void => {
    view.rerender(
      <PaneVisibilityContext.Provider value={next.paneVisible}>
        <TabBodySelectedContext.Provider value={next.tabSelected}>
          <Harness
            tabSelected={next.tabSelected}
            paneVisible={next.paneVisible}
            onResult={capture}
          />
        </TabBodySelectedContext.Provider>
      </PaneVisibilityContext.Provider>,
    );
  };
  return {
    get current(): PresentationHarnessResult {
      return latest;
    },
    rerender,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCanvasPresentation mount retention", () => {
  it("retains the live set immediately when its tab is deselected while the pane stays visible", () => {
    const harness = renderHarness(true, true);
    expect(harness.current.liveBoards).toEqual(new Set([A, B]));

    harness.rerender({ tabSelected: false, paneVisible: true });

    expect(harness.current.liveBoards).toEqual(new Set([A, B]));
  });

  it("releases the retained set once an unselected tab has been hidden for 180000ms", () => {
    vi.useFakeTimers();
    const harness = renderHarness(true, true);
    harness.rerender({ tabSelected: false, paneVisible: true });

    act(() => {
      vi.advanceTimersByTime(180_000);
    });

    expect(harness.current.liveBoards.size).toBe(0);
  });

  it("resumes the live set once the tab is reselected before the retention window expires", () => {
    vi.useFakeTimers();
    const harness = renderHarness(true, true);
    harness.rerender({ tabSelected: false, paneVisible: true });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    harness.rerender({ tabSelected: true, paneVisible: true });

    expect(harness.current.liveBoards).toEqual(new Set([A, B]));
  });

  it("retains the set while the pane itself is hidden too, combining both signals", () => {
    const harness = renderHarness(true, true);
    harness.rerender({ tabSelected: true, paneVisible: false });

    expect(harness.current.liveBoards).toEqual(new Set([A, B]));
  });
});

describe("useCanvasPresentation fullscreen gating", () => {
  it("does not present fullscreen for a board requested while the tab is not selected", () => {
    const harness = renderHarness(false, true);

    act(() => {
      harness.current.setFullscreen(A);
    });

    expect(harness.current.activeFullscreen).toBeNull();
    expect(harness.current.presentationFullscreen).toBe(false);
  });

  it("presents fullscreen once requested while the pane is visible and the tab is selected", () => {
    const harness = renderHarness(true, true);

    act(() => {
      harness.current.setFullscreen(A);
    });

    expect(harness.current.activeFullscreen).toBe(A);
    expect(harness.current.presentationFullscreen).toBe(true);
  });

  it("drops a requested fullscreen board once its tab is deselected", () => {
    const harness = renderHarness(true, true);
    act(() => {
      harness.current.setFullscreen(A);
    });
    expect(harness.current.activeFullscreen).toBe(A);

    harness.rerender({ tabSelected: false, paneVisible: true });

    expect(harness.current.activeFullscreen).toBeNull();
  });
});
