/**
 * The bot tab's resizable panes (decision 80): the handle on a pane's inner
 * edge follows the pointer toward the channel, commits on release into the
 * per-device store, clamps to the pane's range, resets on a double click and
 * nudges on the arrow keys, and a width the person set is the width a fresh
 * mount reads back from storage. The real pane, store and pointer machine run
 * over jsdom, whose layout is the one stub: the pane's measured width.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
import {
  BOT_PANE_BOUNDS,
  useBotPaneWidthsStore,
  type BotPane,
} from "@/stores/bots/bot-pane-widths-store";

const POINTER_ID = 5;
const STORAGE_KEY = "traycer-gui-app:bot-pane-widths";

function Panes(props: {
  readonly pane: BotPane;
  readonly edge: "left" | "right";
}): ReactNode {
  return (
    <BotResizablePane
      pane={props.pane}
      edge={props.edge}
      label="Resize pane"
      className="flex"
      handleClassName=""
      testId="pane"
    >
      <p>Body</p>
    </BotResizablePane>
  );
}

/** Mounts a pane whose measured width follows the inline custom property. */
function mountPane(
  pane: BotPane,
  edge: "left" | "right",
): {
  readonly element: HTMLElement;
  readonly handle: HTMLElement;
} {
  render(<Panes pane={pane} edge={edge} />);
  const element = screen.getByTestId("pane");
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(
    () =>
      new DOMRect(
        0,
        0,
        Number.parseFloat(element.style.getPropertyValue("--bot-pane-width")),
        800,
      ),
  );
  return { element, handle: screen.getByTestId("pane-resize-handle") };
}

function pointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
): void {
  fireEvent(
    target,
    pointerEvent(type, {
      pointerId: POINTER_ID,
      clientX,
      clientY: 10,
      button: 0,
    }),
  );
}

function storedWidths(): unknown {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  localStorage.clear();
  useBotPaneWidthsStore.setState({
    widthPx: {
      sidebar: BOT_PANE_BOUNDS.sidebar.defaultPx,
      thread: BOT_PANE_BOUNDS.thread.defaultPx,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BotResizablePane />", () => {
  it("starts at the pane's default width", () => {
    const { element, handle } = mountPane("sidebar", "right");

    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("256px");
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    expect(handle.getAttribute("aria-valuemin")).toBe("180");
    expect(handle.getAttribute("aria-valuemax")).toBe("420");
  });

  it("widens a pane whose edge faces right as the pointer moves right, storing the width only on release", () => {
    const { element, handle } = mountPane("sidebar", "right");

    pointer(handle, "pointerdown", 300);
    pointer(handle, "pointermove", 340);
    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("296px");
    expect(useBotPaneWidthsStore.getState().widthPx.sidebar).toBe(256);

    pointer(handle, "pointerup", 340);
    expect(useBotPaneWidthsStore.getState().widthPx.sidebar).toBe(296);
  });

  it("widens a pane whose edge faces left as the pointer moves left", () => {
    const { element, handle } = mountPane("thread", "left");

    pointer(handle, "pointerdown", 500);
    pointer(handle, "pointermove", 440);
    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("636px");
    pointer(handle, "pointerup", 440);

    expect(useBotPaneWidthsStore.getState().widthPx.thread).toBe(636);
  });

  it.each([
    {
      pane: "sidebar" as const,
      edge: "right" as const,
      toX: 5_000,
      width: 420,
    },
    {
      pane: "sidebar" as const,
      edge: "right" as const,
      toX: -5_000,
      width: 180,
    },
    { pane: "thread" as const, edge: "left" as const, toX: -5_000, width: 900 },
    { pane: "thread" as const, edge: "left" as const, toX: 5_000, width: 320 },
  ])(
    "keeps a $pane drag to $toX inside its range, at $width",
    ({ pane, edge, toX, width }) => {
      const { element, handle } = mountPane(pane, edge);

      pointer(handle, "pointerdown", 0);
      pointer(handle, "pointermove", toX);
      expect(element.style.getPropertyValue("--bot-pane-width")).toBe(
        `${width}px`,
      );
      pointer(handle, "pointerup", toX);

      expect(useBotPaneWidthsStore.getState().widthPx[pane]).toBe(width);
    },
  );

  it("puts the width back when a drag is cancelled with Escape", () => {
    const { element, handle } = mountPane("sidebar", "right");

    pointer(handle, "pointerdown", 300);
    pointer(handle, "pointermove", 340);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("256px");
    expect(useBotPaneWidthsStore.getState().widthPx.sidebar).toBe(256);
  });

  it("resets to the default on a double click", () => {
    useBotPaneWidthsStore.getState().setWidthPx("thread", 700);
    const { element, handle } = mountPane("thread", "left");
    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("700px");

    fireEvent.doubleClick(handle);

    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("576px");
    expect(useBotPaneWidthsStore.getState().widthPx.thread).toBe(576);
  });

  it("nudges 24px per arrow key toward growing, and stops at the range", () => {
    const { element, handle } = mountPane("sidebar", "right");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("280px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("232px");

    for (let press = 0; press < 20; press += 1) {
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
    }
    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("180px");
  });

  it("flips the arrows for a pane whose edge faces left", () => {
    const { element, handle } = mountPane("thread", "left");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("600px");
  });
});

describe("<BotResizablePane /> drawn narrower than its stored width", () => {
  const STORED_PX = 400;
  const DRAWN_PX = 300;

  /** Reports a size as soon as it observes, as a laid-out pane's observer does. */
  class StubResizeObserver implements ResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      this.callback();
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  /** A pane a cap holds at DRAWN_PX though the store says STORED_PX. */
  function mountCapped(
    pane: BotPane,
    edge: "left" | "right",
  ): { readonly handle: HTMLElement } {
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    useBotPaneWidthsStore.getState().setWidthPx(pane, STORED_PX);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, DRAWN_PX, 800),
    );
    render(<Panes pane={pane} edge={edge} />);
    return { handle: screen.getByTestId("pane-resize-handle") };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("announces the drawn width, not the stored one", () => {
    const { handle } = mountCapped("sidebar", "right");

    expect(handle.getAttribute("aria-valuenow")).toBe(String(DRAWN_PX));
  });

  it.each([
    {
      pane: "sidebar" as const,
      edge: "right" as const,
      key: "ArrowRight",
      width: DRAWN_PX + 24,
    },
    {
      pane: "thread" as const,
      edge: "left" as const,
      key: "ArrowLeft",
      width: DRAWN_PX + 24,
    },
    {
      pane: "sidebar" as const,
      edge: "right" as const,
      key: "ArrowLeft",
      width: DRAWN_PX - 24,
    },
  ])(
    "nudges the $pane from the drawn width on $key",
    ({ pane, edge, key, width }) => {
      const { handle } = mountCapped(pane, edge);

      act(() => {
        fireEvent.keyDown(handle, { key });
      });

      expect(useBotPaneWidthsStore.getState().widthPx[pane]).toBe(width);
    },
  );
});

describe("the stored pane widths", () => {
  it("are what a fresh mount reads after the person resized", async () => {
    const { handle } = mountPane("sidebar", "right");
    pointer(handle, "pointerdown", 300);
    pointer(handle, "pointermove", 360);
    pointer(handle, "pointerup", 360);
    const saved = localStorage.getItem(STORAGE_KEY);
    expect(storedWidths()).toMatchObject({
      state: { widthPx: { sidebar: 316, thread: 576 } },
    });
    cleanup();

    // A reload: the in-memory store is back at its defaults and reads what
    // the last session left in storage.
    useBotPaneWidthsStore.setState({
      widthPx: { sidebar: 256, thread: 576 },
    });
    if (saved === null) throw new Error("the resize stored nothing");
    localStorage.setItem(STORAGE_KEY, saved);
    await useBotPaneWidthsStore.persist.rehydrate();
    const { element } = mountPane("sidebar", "right");

    expect(element.style.getPropertyValue("--bot-pane-width")).toBe("316px");
  });

  it("are clamped pane by pane when storage holds an out-of-range or malformed width", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { widthPx: { sidebar: 9_999, thread: "wide" } },
        version: 1,
      }),
    );

    await useBotPaneWidthsStore.persist.rehydrate();

    expect(useBotPaneWidthsStore.getState().widthPx).toEqual({
      sidebar: 420,
      thread: 576,
    });
  });
});
