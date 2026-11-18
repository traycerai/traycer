import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  ChatDockAttachedPanelBody,
  ChatDockAttachedPanelSlot,
} from "@/components/chat/chat-dock-attached-panel";
import {
  CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO,
  CHAT_DOCK_PANEL_HEIGHT_PROPERTY,
  CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO,
  CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO,
  chatDockPanelHeightCss,
  chatDockPanelPaneHeight,
  clampChatDockPanelHeightRatio,
} from "@/lib/chat/chat-dock-panel-height";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * L-145: the opened pill panel's cap is a share of the CHAT PANE, not of the
 * window. L-151: it is a CAP, not a height - the panel is as tall as its
 * content and scrolls past that share.
 *
 * The case that made the first a defect is a chat TILE on a canvas with
 * several of them: the pane here is 400px inside jsdom's 768px window, so
 * every number below separates the two readings rather than merely agreeing
 * with one. The second is not measurable in jsdom at all - it lays nothing
 * out - so what is pinned here is the STYLE the browser is handed, which is
 * where the defect lived: a `height` where a `max-height` was meant.
 */
const PANE_HEIGHT = 400;

/** jsdom measures everything as zero, so the pane states its own height. */
function stubPaneHeight(pane: HTMLElement, height: number): void {
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 600,
    bottom: height,
    width: 600,
    height,
    toJSON: () => ({}),
  });
}

/**
 * A body showing less than it holds, which is the only state in which the cap
 * is doing anything and so the only one that offers the handle (L-164).
 *
 * jsdom answers 0 to every layout question, so a panel here never scrolls
 * until it is told it does - and one test below is about exactly that.
 */
function stubPanelScrolling(): void {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    function (this: Element) {
      return this.hasAttribute("data-dock-panel-body") ? 500 : 0;
    },
  );
}

function renderPanelInPane(paneHeight: number): HTMLElement {
  render(
    <div data-chat-pane="" data-testid="chat-pane">
      <ChatDockAttachedPanelSlot
        section="filesChanged"
        panelId="dock-panel-1"
        separated={false}
        settled
      >
        <ChatDockAttachedPanelBody section="filesChanged" testId="panel-rows">
          <div>a row</div>
        </ChatDockAttachedPanelBody>
      </ChatDockAttachedPanelSlot>
    </div>,
  );
  const pane = screen.getByTestId("chat-pane");
  stubPaneHeight(pane, paneHeight);
  return pane;
}

/** The same panel, with a body that is actually scrolling. */
function renderScrollingPanelInPane(paneHeight: number): HTMLElement {
  stubPanelScrolling();
  return renderPanelInPane(paneHeight);
}

function handle(): HTMLElement {
  return screen.getByTestId("chat-dock-attached-panel-resize");
}

function slot(): HTMLElement {
  return screen.getByTestId("chat-dock-attached-panel-slot");
}

function dragHandleBy(deltaY: number): void {
  const grip = handle();
  grip.setPointerCapture = () => undefined;
  act(() => {
    fireEvent.pointerDown(grip, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientY: 500,
    });
  });
  act(() => {
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 500 - deltaY });
  });
  act(() => {
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 500 - deltaY });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({
    chatDockPanelHeight: CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO,
  });
});

describe("the pill panel hugs its content, up to a share of the chat pane", () => {
  it("caps the body rather than sizing it", () => {
    renderPanelInPane(PANE_HEIGHT);

    // Read as CLASSES, not as a substring: `max-h-[...]` contains `h-[...]`,
    // so a `toContain` here would pass against the very utility this test
    // exists to refuse.
    const classes = (
      screen.getByTestId("panel-rows").getAttribute("class") ?? ""
    )
      .split(/\s+/)
      .filter(Boolean);
    // The whole of L-151 in two lines: the share is the point the body STOPS
    // growing, and nothing anywhere tells it how tall to be. Five todo rows
    // draw five todo rows; a long file list stops here and scrolls.
    expect(classes).toContain(
      `max-h-[var(${CHAT_DOCK_PANEL_HEIGHT_PROPERTY})]`,
    );
    expect(classes).not.toContain(
      `h-[var(${CHAT_DOCK_PANEL_HEIGHT_PROPERTY})]`,
    );
    expect(classes).toContain("overflow-y-auto");
  });

  it("draws a pane-relative cap, never a window-relative one", () => {
    renderPanelInPane(PANE_HEIGHT);

    // The property is on the SLOT, which is where the handle that moves it
    // lives; it inherits down to whichever panel is open inside.
    const cap = slot().style.getPropertyValue(CHAT_DOCK_PANEL_HEIGHT_PROPERTY);
    expect(cap).toContain("cqh");
    expect(cap).not.toContain("dvh");
    expect(cap).not.toContain("vh)");
    // The pane is the nearest SIZE container, so the share resolves against
    // it and against nothing else on the way up.
    // The default third, floored at 6rem, and a pane too short for the floor
    // lowers the cap rather than being buried.
    expect(cap).toBe("min(50cqh, max(6rem, 33cqh))");
  });

  it("clamps to half the pane and to a usable minimum", () => {
    expect(clampChatDockPanelHeightRatio(0.9)).toBe(
      CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO,
    );
    expect(clampChatDockPanelHeightRatio(0.01)).toBe(
      CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO,
    );
    expect(clampChatDockPanelHeightRatio(Number.NaN)).toBe(
      CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO,
    );
    expect(chatDockPanelHeightCss(12)).toBe("min(50cqh, max(6rem, 12cqh))");
  });

  it("measures the chat pane it is inside, and the window only without one", () => {
    const pane = renderScrollingPanelInPane(PANE_HEIGHT);
    const grip = handle();

    expect(chatDockPanelPaneHeight(grip)).toBe(PANE_HEIGHT);
    expect(chatDockPanelPaneHeight(null)).toBe(window.innerHeight);
    // The landing composer's dock has no pane above it: the window is the
    // fallback there, which is what `cqh` itself falls back to.
    pane.removeAttribute("data-chat-pane");
    expect(chatDockPanelPaneHeight(grip)).toBe(window.innerHeight);
    expect(window.innerHeight).not.toBe(PANE_HEIGHT);
  });

  it("drags 1:1 against the pane, not against the window", () => {
    renderScrollingPanelInPane(PANE_HEIGHT);

    // 60px up on a 400px pane is +15 points. On jsdom's 768px window the same
    // gesture would be +8, which is the reading L-145 removed.
    dragHandleBy(60);

    expect(useSettingsStore.getState().chatDockPanelHeight).toBeCloseTo(0.48);
    expect(handle().getAttribute("aria-valuenow")).toBe("48");
  });

  it("keeps the handle's ARIA truthful about what the share is of", () => {
    renderScrollingPanelInPane(PANE_HEIGHT);
    const grip = handle();

    expect(grip.getAttribute("aria-valuemin")).toBe("12");
    expect(grip.getAttribute("aria-valuemax")).toBe("50");
    expect(grip.getAttribute("aria-valuenow")).toBe("33");
    expect(grip.getAttribute("aria-valuetext")).toBe("33% of the chat pane");

    // Keyboard resize and the double-click reset still land on the same scale.
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(handle().getAttribute("aria-valuenow")).toBe("35");
    // The step is the stored preference, not only the handle's reading.
    expect(useSettingsStore.getState().chatDockPanelHeight).toBeCloseTo(0.35);
    fireEvent.keyDown(grip, { key: "Home" });
    expect(handle().getAttribute("aria-valuenow")).toBe("50");
    // Half the pane is a ceiling: a further step cannot bury the transcript.
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(handle().getAttribute("aria-valuenow")).toBe("50");
    fireEvent.doubleClick(grip);
    expect(handle().getAttribute("aria-valuenow")).toBe("33");
    expect(handle().getAttribute("aria-valuetext")).toBe(
      "33% of the chat pane",
    );
  });

  // L-164: the handle sets the cap, and the cap is only doing something while
  // the body is showing less than it holds. A handle offered over five todo
  // rows wrote `aria-valuenow`, the store and `localStorage` and moved not one
  // pixel, and dragging it down did nothing until the cap crossed the content
  // height, at which point the panel started shrinking mid-gesture.
  it("offers the handle only while the body is scrolling, and stores the same cap either way", () => {
    renderPanelInPane(PANE_HEIGHT);

    expect(screen.queryByTestId("chat-dock-attached-panel-resize")).toBeNull();
    // The stored cap is untouched by the handle going: it is a preference,
    // not a function of what happens to be in the panel right now.
    expect(useSettingsStore.getState().chatDockPanelHeight).toBe(
      CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO,
    );
    expect(slot().style.getPropertyValue(CHAT_DOCK_PANEL_HEIGHT_PROPERTY)).toBe(
      "min(50cqh, max(6rem, 33cqh))",
    );

    cleanup();
    renderScrollingPanelInPane(PANE_HEIGHT);

    expect(handle().getAttribute("aria-valuenow")).toBe("33");
  });
});
