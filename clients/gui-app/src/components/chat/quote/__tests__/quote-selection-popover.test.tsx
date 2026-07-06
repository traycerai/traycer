import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { RefObject } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import { QuoteSelectionPopover } from "../quote-selection-popover";
import { firstLineRect, firstVisibleLineRect } from "../quote-anchor-rect";
import type { QuoteSelectionSnapshot } from "../use-quote-selection";

// No transcript viewport: the popover falls back to first-line anchoring and
// never clips, which is what most of these focus/guard tests want.
const NO_BOUNDARY: RefObject<HTMLElement | null> = { current: null };

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  useComposerDraftStore.setState({ drafts: {} });
  vi.restoreAllMocks();
});

function selectRange(range: Range): void {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function nonZeroRect(): DOMRect {
  return {
    x: 10,
    y: 20,
    width: 120,
    height: 18,
    top: 20,
    left: 10,
    right: 130,
    bottom: 38,
    toJSON: () => ({}),
  };
}

/** A snapshot whose range nodes are connected and report a non-zero rect, so
 *  the anchor guard keeps the popover mounted (jsdom has no real layout). */
function makeAnchoredSnapshot(): {
  readonly snapshot: QuoteSelectionSnapshot;
  readonly host: HTMLElement;
} {
  const host = document.createElement("div");
  host.setAttribute("data-quotable", "true");
  host.textContent = "quotable text";
  document.body.appendChild(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => nonZeroRect(),
  });
  // The popover's liveness guard reads the live selection, so a realistic
  // snapshot needs a matching one behind it.
  selectRange(range);
  return {
    snapshot: { text: "quotable text", fenceLanguage: null, range, root: host },
    host,
  };
}

function renderPopover(
  snapshot: QuoteSelectionSnapshot,
  onDismiss: () => void,
): void {
  render(
    <TooltipProvider>
      <QuoteSelectionPopover
        taskId="task-1"
        snapshot={snapshot}
        onDismiss={onDismiss}
        boundaryRef={NO_BOUNDARY}
      />
    </TooltipProvider>,
  );
}

function popoverElement(): HTMLElement {
  const element = document.querySelector(
    '[data-slot="quote-selection-popover"]',
  );
  if (!(element instanceof HTMLElement)) throw new Error("popover not mounted");
  return element;
}

describe("QuoteSelectionPopover - focus contract", () => {
  it("does not change document.activeElement when it mounts", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const { snapshot } = makeAnchoredSnapshot();
    renderPopover(snapshot, () => undefined);

    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("button", { name: "Quote" })).toBeTruthy();
  });

  it("preventDefaults the button mousedown so it never takes focus", () => {
    const { snapshot } = makeAnchoredSnapshot();
    renderPopover(snapshot, () => undefined);

    const button = screen.getByRole("button", { name: "Quote" });
    // fireEvent returns false when the (cancelable) event had preventDefault called.
    const notPrevented = fireEvent.mouseDown(button);
    expect(notPrevented).toBe(false);
  });
});

describe("QuoteSelectionPopover - quote action", () => {
  it("appends the quote to the draft and dismisses on click", () => {
    const { snapshot } = makeAnchoredSnapshot();
    const onDismiss = vi.fn();
    renderPopover(snapshot, onDismiss);

    fireEvent.click(screen.getByRole("button", { name: "Quote" }));

    const draft = readComposerDraftSnapshot("task-1");
    expect(JSON.stringify(draft.content)).toContain("blockquote");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("QuoteSelectionPopover - anchor guard", () => {
  it("stays mounted while the anchor range is connected and paintable", () => {
    const onDismiss = vi.fn();
    const { snapshot } = makeAnchoredSnapshot();
    renderPopover(snapshot, onDismiss);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Quote" })).toBeTruthy();
  });

  it("dismisses instead of repositioning when the range nodes are disconnected", () => {
    const onDismiss = vi.fn();
    // The anchor nodes are never attached (mirrors a virtualized row unmount).
    const host = document.createElement("div");
    host.textContent = "gone";
    const range = document.createRange();
    range.selectNodeContents(host);
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => nonZeroRect(),
    });

    renderPopover(
      { text: "gone", fenceLanguage: null, range, root: host },
      onDismiss,
    );

    expect(onDismiss).toHaveBeenCalled();
  });

  it("dismisses when the anchored rect is zero/degenerate", () => {
    const onDismiss = vi.fn();
    const host = document.createElement("div");
    host.setAttribute("data-quotable", "true");
    host.textContent = "quotable";
    document.body.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    selectRange(range);
    // No rect stub: jsdom reports a zero rect, which the guard treats as
    // degenerate (a row hidden via content-visibility in the real app).

    renderPopover(
      { text: "quotable", fenceLanguage: null, range, root: host },
      onDismiss,
    );

    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("QuoteSelectionPopover - liveness guard", () => {
  it("dismisses when the live selection no longer sits in the snapshot root", () => {
    const onDismiss = vi.fn();
    // Connected root + paintable rect, but the selection has collapsed (mirrors
    // toggle-off -> collapse -> toggle-on: the snapshot outlived its selection).
    const { snapshot } = makeAnchoredSnapshot();
    window.getSelection()?.removeAllRanges();

    renderPopover(snapshot, onDismiss);

    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("QuoteSelectionPopover - scrolled-past-start (viewport clipping)", () => {
  function scrolledFixture(lineRects: ReadonlyArray<DOMRect>): {
    readonly snapshot: QuoteSelectionSnapshot;
    readonly boundaryRef: RefObject<HTMLElement | null>;
  } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => rectOf(0, 0, 1000, 600),
    });
    const { snapshot } = makeAnchoredSnapshot();
    Object.defineProperty(snapshot.range, "getClientRects", {
      configurable: true,
      value: () => makeClientRects(lineRects),
    });
    return { snapshot, boundaryRef: { current: container } };
  }

  function renderWithBoundary(
    snapshot: QuoteSelectionSnapshot,
    boundaryRef: RefObject<HTMLElement | null>,
    onDismiss: () => void,
  ): void {
    render(
      <TooltipProvider>
        <QuoteSelectionPopover
          taskId="task-1"
          snapshot={snapshot}
          onDismiss={onDismiss}
          boundaryRef={boundaryRef}
        />
      </TooltipProvider>,
    );
  }

  it("hides (without dismissing) when the whole selection is scrolled out of the viewport", () => {
    const onDismiss = vi.fn();
    // A single selected line sitting above the viewport top.
    const { snapshot, boundaryRef } = scrolledFixture([
      rectOf(50, -120, 200, 16),
    ]);

    renderWithBoundary(snapshot, boundaryRef, onDismiss);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(popoverElement().style.visibility).toBe("hidden");
  });

  it("shows the button anchored to the first line still visible in the viewport", () => {
    const onDismiss = vi.fn();
    const { snapshot, boundaryRef } = scrolledFixture([
      rectOf(50, 120, 200, 16),
    ]);

    renderWithBoundary(snapshot, boundaryRef, onDismiss);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(popoverElement().style.visibility).toBe("visible");
    expect(screen.getByRole("button", { name: "Quote" })).toBeTruthy();
  });

  it("re-shows when a scrolled-out selection scrolls a line back into view", () => {
    const onDismiss = vi.fn();
    const container = document.createElement("div");
    // Overflow:auto makes Floating UI treat the container as a scroll ancestor
    // of the root (contextElement), so autoUpdate repositions on its scroll.
    container.style.overflowY = "auto";
    const host = document.createElement("div");
    host.setAttribute("data-quotable", "true");
    host.textContent = "quotable text";
    container.appendChild(host);
    document.body.appendChild(container);
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => rectOf(0, 0, 1000, 600),
    });

    const range = document.createRange();
    range.selectNodeContents(host);
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => rectOf(50, 120, 200, 16),
    });
    // Starts above the viewport; flips into view on the second read.
    let line = rectOf(50, -120, 200, 16);
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () => makeClientRects([line]),
    });
    selectRange(range);

    const boundaryRef: RefObject<HTMLElement | null> = { current: container };
    renderWithBoundary(
      { text: "quotable text", fenceLanguage: null, range, root: host },
      boundaryRef,
      onDismiss,
    );
    expect(popoverElement().style.visibility).toBe("hidden");

    line = rectOf(50, 200, 200, 16);
    act(() => {
      container.dispatchEvent(new Event("scroll"));
    });

    expect(popoverElement().style.visibility).toBe("visible");
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("firstLineRect / firstVisibleLineRect", () => {
  it("firstLineRect returns the first client rect, falling back to the bounding box", () => {
    const range = document.createRange();
    const firstLine = rectOf(10, 20, 100, 16);
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () => makeClientRects([firstLine, rectOf(10, 40, 240, 16)]),
    });
    expect(firstLineRect(range)).toBe(firstLine);

    const range2 = document.createRange();
    const boundingBox = rectOf(10, 20, 240, 36);
    Object.defineProperty(range2, "getClientRects", {
      configurable: true,
      value: () => makeClientRects([]),
    });
    Object.defineProperty(range2, "getBoundingClientRect", {
      configurable: true,
      value: () => boundingBox,
    });
    expect(firstLineRect(range2)).toBe(boundingBox);
  });

  it("firstVisibleLineRect returns the first line that intersects the viewport", () => {
    const range = document.createRange();
    const above = rectOf(50, -40, 200, 16);
    const visible = rectOf(50, 20, 200, 16);
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () => makeClientRects([above, visible]),
    });

    expect(firstVisibleLineRect(range, rectOf(0, 0, 1000, 600))).toBe(visible);
  });

  it("firstVisibleLineRect returns null when every line is outside the viewport", () => {
    const range = document.createRange();
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () =>
        makeClientRects([rectOf(50, -80, 200, 16), rectOf(50, 700, 200, 16)]),
    });

    expect(firstVisibleLineRect(range, rectOf(0, 0, 1000, 600))).toBeNull();
  });
});

function rectOf(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

function makeClientRects(rects: ReadonlyArray<DOMRect>) {
  const list = rects.slice();
  return Object.assign(list, {
    item: (index: number): DOMRect | null =>
      index >= 0 && index < list.length ? list[index] : null,
  });
}
