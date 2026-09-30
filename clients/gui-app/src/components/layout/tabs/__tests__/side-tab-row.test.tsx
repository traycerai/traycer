import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import {
  SideTabRow,
  type SideTabDisclosure,
  type SideTabRowClose,
  type SideTabRowProps,
  type SideTabRowStatus,
} from "../side-strip/side-tab-row";
import { SideSplitRowPair } from "../side-strip/side-split-row-pair";
import type { SideTabLiveAgents } from "../side-strip/agent-meter";
import { NO_LIVE_AGENTS } from "../side-strip/side-tab-live-agents";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import {
  SIDE_SPLIT_PAIR_CLASS,
  SIDE_SPLIT_PAIR_COLLAPSED_HAIRLINE_CLASS,
  SIDE_SPLIT_PAIR_EXPANDED_HAIRLINE_CLASS,
  SIDE_TAB_ACTIVE_CLASS,
  SIDE_TAB_GROUP_LINE_CLASS,
  SIDE_TAB_GROUP_LINE_SEAT_CLASS,
  SIDE_TAB_ROW_CLASS,
  SIDE_TAB_SESSION_ACTIVE_CLASS,
  SIDE_TAB_TILE_ACTIVE_CLASS,
  SIDE_TAB_TILE_CLASS,
  SIDE_TAB_TILE_HOVER_CLASS,
} from "../side-strip/side-strip-tokens";
import { SESSION_TAB_LABEL_CLASS } from "../header-tab-visual";
import {
  SIDE_TAB_COLORLESS_TILE_CLASS,
  SIDE_TAB_MONOGRAM_CHIP_CLASS,
  SIDE_TAB_TINT_FILL_CLASS,
} from "../tab-identity";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThemeLibraryStore.setState({ panelAnimations: true });
});

const ROW_TEST_ID = "tab-epic-e1";

/** A frame fixture: the div props plus the data attributes the strip sets. */
type Frame = ComponentPropsWithRef<"div"> & {
  readonly [key: `data-${string}`]: string;
};

function closeControl(onClose: () => void): SideTabRowClose {
  return {
    label: "Close Fix login",
    testId: "tab-close-epic-e1",
    disabled: false,
    onClose,
  };
}

/** A chip or the meter: it stays, and the close joins after it. */
const CHIP: SideTabRowStatus = {
  yieldsToClose: false,
  node: <span data-testid="status-chip" />,
};

function disclosureControl(): SideTabDisclosure {
  return {
    expanded: false,
    animate: false,
    controlsId: "agents-e1",
    label: "Show agents in Fix login",
    onToggle: () => {},
  };
}

function rowFrame(extra: Frame): Frame {
  return { "data-testid": ROW_TEST_ID, ...extra };
}

function baseProps(): SideTabRowProps {
  return {
    frame: rowFrame({}),
    variant: "expanded",
    active: false,
    session: null,
    tint: null,
    groupLine: null,
    titleIcon: null,
    tile: { kind: "monogram", text: "FL" },
    badge: null,
    agents: NO_LIVE_AGENTS,
    status: null,
    section: null,
    disclosure: null,
    title: "Fix login",
    hoverCardBody: <div data-testid="hover-card-probe">Fix login</div>,
    hoverCardOnOverflow: false,
    leaderBadge: null,
    close: null,
    dropIndicator: null,
    pairPreview: null,
    dragSource: false,
  };
}

function agents(
  turn: number,
  background: number,
  coverage: AgentActivityCoverage,
): SideTabLiveAgents {
  return { turn, background, coverage };
}

function renderRow(overrides: Partial<SideTabRowProps>): HTMLElement {
  render(<SideTabRow {...baseProps()} {...overrides} />);
  return screen.getByTestId(ROW_TEST_ID);
}

function hasClasses(element: Element, classes: string): boolean {
  return classes.split(" ").every((token) => element.classList.contains(token));
}

function closeWrapper(): HTMLElement {
  const wrapper = screen.getByTestId("tab-close-epic-e1").parentElement;
  if (wrapper === null) throw new Error("expected the close wrapper");
  return wrapper;
}

function trailing(row: HTMLElement): HTMLElement {
  const slot = row.querySelector<HTMLElement>(
    '[data-testid="side-tab-trailing"]',
  );
  if (slot === null) throw new Error("expected a trailing slot");
  return slot;
}

describe("SideTabRow expanded trailing slot", () => {
  const leader: ReactNode = <span data-testid="leader-badge">1</span>;

  it("shows the leader badge over the close and the status", () => {
    for (const active of [true, false]) {
      const row = renderRow({
        active,
        leaderBadge: leader,
        close: closeControl(() => {}),
        status: CHIP,
      });
      const slot = trailing(row);
      expect(slot.querySelector('[data-testid="leader-badge"]')).not.toBeNull();
      expect(screen.queryByTestId("tab-close-epic-e1")).toBeNull();
      expect(screen.queryByTestId("status-chip")).toBeNull();
      cleanup();
    }
  });

  it("reveals the close on hover or keyboard focus on an inactive row", () => {
    renderRow({ active: false, close: closeControl(() => {}) });
    const wrapper = closeWrapper();
    expect(wrapper.dataset.revealed).toBe("on-hover-or-focus");
    expect(hasClasses(wrapper, "pointer-events-none opacity-0")).toBe(true);
    expect(
      hasClasses(
        wrapper,
        "group-hover/side-tab:opacity-100 group-focus-visible/side-tab:opacity-100 group-has-[:focus-visible]/side-tab:opacity-100",
      ),
    ).toBe(true);
    expect(wrapper.className).not.toContain("header-tab");
  });

  it("gives the chevron no room until the row is hovered or focused", () => {
    renderRow({
      close: closeControl(() => {}),
      status: CHIP,
      disclosure: disclosureControl(),
    });
    const chevronCell = screen.getByTestId("side-tab-disclosure").parentElement;
    expect(
      chevronCell !== null &&
        hasClasses(
          chevronCell,
          "w-0 group-hover/side-tab:w-5 group-has-[:focus-visible]/side-tab:w-5",
        ),
    ).toBe(true);
  });

  it("renders an empty trailing slot when nothing applies", () => {
    const row = renderRow({});
    expect(trailing(row).childElementCount).toBe(0);
  });

  it("closes without activating the row", () => {
    const onClose = vi.fn();
    const onRowClick = vi.fn();
    renderRow({
      active: true,
      close: closeControl(onClose),
      frame: rowFrame({ onClick: onRowClick }),
    });
    fireEvent.click(screen.getByTestId("tab-close-epic-e1"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Close Fix login" }),
    ).toBeTruthy();
  });
});

function byTestId(root: HTMLElement, testId: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`expected ${testId}`);
  return element;
}

function hoverCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="hover-card-content"]',
  );
}

function dwell(row: HTMLElement): void {
  // `useHover`'s open-delay timer lives on a native `mouseenter` listener
  // Floating UI attaches directly to the DOM node, gated on the pointer type
  // `onPointerEnter` (a React prop) just recorded - both have to fire, like a
  // real browser's compat mouse events would.
  fireEvent.pointerEnter(row, { pointerType: "mouse" });
  fireEvent.mouseEnter(row);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
}

// jsdom has no global `AnimationEvent`, so React's vendor-prefix probe lands
// on `webkitAnimationEnd` rather than plain `animationend`
// (`chat-dock-compact-chip.test.tsx` hit the same gap), and a bare `Event`
// carries no `animationName`. Set it by hand before dispatch so
// `useWaitingPulse`'s name check can see it.
function fireWaitingPulseAnimationEnd(
  element: Element,
  animationName: string,
): void {
  const event = new Event("webkitAnimationEnd", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "animationName", { value: animationName });
  fireEvent(element, event);
}

describe("SideTabRow expanded paint", () => {
  it("lays out the title and the trailing edge, with nothing before the title", () => {
    const row = renderRow({});
    const order = Array.from(row.children)
      .map((child) => child.getAttribute("data-testid"))
      .filter((id) => id !== null);
    expect(order).toEqual([
      "side-tab-accent",
      "side-tab-title",
      "side-tab-trailing",
    ]);
    expect(hasClasses(row, SIDE_TAB_ROW_CLASS)).toBe(true);
  });

  it("fades a string title and keeps a rename input as given", () => {
    const row = renderRow({});
    expect(row.querySelector(".header-tab-title-text")?.textContent).toBe(
      "Fix login",
    );
    cleanup();
    const renamed = renderRow({
      title: <input data-testid="rename-input" defaultValue="Fix login" />,
    });
    expect(
      renamed.querySelector('[data-testid="rename-input"]'),
    ).not.toBeNull();
    expect(renamed.querySelector(".header-tab-title-text")).toBeNull();
  });

  it("draws a title icon inline as the title's first content", () => {
    const row = renderRow({
      titleIcon: <span data-testid="title-icon">🚀</span>,
    });
    const title = byTestId(row, "side-tab-title");
    expect(title.firstElementChild?.firstElementChild).toBe(
      byTestId(row, "title-icon"),
    );
    expect(title.textContent).toBe("🚀Fix login");
  });

  it("mutes the title of a task whose title is still generating", () => {
    const generating = renderRow({ tile: { kind: "generating" } });
    expect(
      generating
        .querySelector(".header-tab-title-text")
        ?.classList.contains("text-muted-foreground"),
    ).toBe(true);
    cleanup();

    const titled = renderRow({});
    expect(
      titled
        .querySelector(".header-tab-title-text")
        ?.classList.contains("text-muted-foreground"),
    ).toBe(false);
  });

  it("keeps a tab's colour on the accent bar alone, and a colourless tab's bar transparent", () => {
    const coloured = renderRow({ tint: "#3366ff" });
    const accent = byTestId(coloured, "side-tab-accent");
    expect(accent.dataset.accent).toBe("true");
    expect(accent.style.getPropertyValue("--side-tab-accent")).toBe("#3366ff");
    cleanup();

    const plain = renderRow({ tint: null });
    const bar = byTestId(plain, "side-tab-accent");
    expect(bar.dataset.accent).toBe("false");
    expect(bar.style.getPropertyValue("--side-tab-accent")).toBe("transparent");
  });

  it("fills the active row and not an inactive one", () => {
    const active = renderRow({ active: true });
    expect(hasClasses(active, SIDE_TAB_ACTIVE_CLASS)).toBe(true);
    cleanup();
    const idle = renderRow({ active: false });
    expect(hasClasses(idle, SIDE_TAB_ACTIVE_CLASS)).toBe(false);
  });

  it("draws the group colour line outside the fill, joined across the gap", () => {
    const row = renderRow({
      groupLine: { color: "#ff8800", seat: "row" },
      active: true,
    });
    const line = byTestId(row, "side-tab-group-line");
    expect(line.style.getPropertyValue("--side-tab-group-line")).toBe(
      "#ff8800",
    );
    expect(hasClasses(line, SIDE_TAB_GROUP_LINE_CLASS)).toBe(true);
    expect(hasClasses(line, SIDE_TAB_GROUP_LINE_SEAT_CLASS.expanded.row)).toBe(
      true,
    );
    expect(line.className).not.toContain("rounded");
  });

  it("places a split pair member's segment by its seat in the pair", () => {
    const row = renderRow({
      groupLine: { color: "#ff8800", seat: "pair-top" },
      active: false,
    });
    const line = byTestId(row, "side-tab-group-line");
    expect(line.getAttribute("data-seat")).toBe("pair-top");
    expect(
      hasClasses(line, SIDE_TAB_GROUP_LINE_SEAT_CLASS.expanded["pair-top"]),
    ).toBe(true);
    expect(hasClasses(line, SIDE_TAB_GROUP_LINE_SEAT_CLASS.expanded.row)).toBe(
      false,
    );
  });

  it("opens the hover card body on hover, expanded as well as collapsed", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = renderRow({});
    dwell(row);
    expect(hoverCard()?.textContent).toBe("Fix login");
    expect(
      hoverCard()?.querySelector('[data-testid="hover-card-probe"]'),
    ).not.toBeNull();
  });

  it("keeps the hover card closed while a row is being renamed", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = renderRow({
      title: <input data-testid="rename-input" defaultValue="Fix login" />,
    });
    dwell(row);
    expect(hoverCard()).toBeNull();
  });
});

describe("SideTabRow collapsed", () => {
  it("renders no trailing slot, even active, with a close and with focus", () => {
    const row = renderRow({
      variant: "collapsed",
      active: true,
      close: closeControl(() => {}),
      status: CHIP,
      leaderBadge: <span data-testid="leader-badge">1</span>,
      frame: rowFrame({ tabIndex: 0 }),
    });
    act(() => row.focus());
    expect(row.querySelector('[data-testid="side-tab-trailing"]')).toBeNull();
    expect(screen.queryByTestId("tab-close-epic-e1")).toBeNull();
    expect(screen.queryByTestId("status-chip")).toBeNull();
    expect(screen.queryByTestId("leader-badge")).toBeNull();
  });

  it("is the 40x44 tile itself, filled the same as an active expanded row", () => {
    const row = renderRow({
      variant: "collapsed",
      active: true,
      tint: "#22aa66",
    });
    expect(hasClasses(row, SIDE_TAB_TILE_CLASS)).toBe(true);
    expect(hasClasses(row, SIDE_TAB_TILE_ACTIVE_CLASS)).toBe(true);
    expect(hasClasses(row, SIDE_TAB_ROW_CLASS)).toBe(false);
    cleanup();
    const idle = renderRow({ variant: "collapsed", active: false });
    expect(hasClasses(idle, SIDE_TAB_TILE_HOVER_CLASS)).toBe(true);
    expect(hasClasses(idle, SIDE_TAB_TILE_ACTIVE_CLASS)).toBe(false);
  });

  it("keeps the collapsed monogram chip neutral, the tab colour on the accent ring", () => {
    const row = renderRow({ variant: "collapsed", tint: "#22aa66" });
    expect(row.dataset.tileKind).toBe("monogram");
    expect(row.textContent).toBe("FL");
    const chip = byTestId(row, "side-tab-monogram-chip");
    expect(hasClasses(chip, SIDE_TAB_MONOGRAM_CHIP_CLASS)).toBe(true);
    expect(hasClasses(chip, SIDE_TAB_TINT_FILL_CLASS)).toBe(false);
    expect(hasClasses(chip, SIDE_TAB_COLORLESS_TILE_CLASS)).toBe(true);
    expect(chip.style.getPropertyValue("--side-tab-tint")).toBe("");
    const accent = byTestId(row, "side-tab-accent");
    expect(accent.dataset.accent).toBe("true");
    expect(accent.style.getPropertyValue("--side-tab-accent")).toBe("#22aa66");
    expect(hasClasses(row, SIDE_TAB_ACTIVE_CLASS)).toBe(false);
  });

  it("renders the accent ring transparent for a colourless tab, never a hashed colour", () => {
    const row = renderRow({
      variant: "collapsed",
      tint: null,
      tile: { kind: "icon", icon: <svg data-testid="custom-icon" /> },
    });
    expect(row.dataset.tileKind).toBe("icon");
    const chip = byTestId(row, "side-tab-monogram-chip");
    expect(hasClasses(chip, SIDE_TAB_COLORLESS_TILE_CLASS)).toBe(true);
    expect(chip.style.getPropertyValue("--side-tab-tint")).toBe("");
    expect(row.querySelector('[data-testid="custom-icon"]')).not.toBeNull();
    const accent = byTestId(row, "side-tab-accent");
    expect(accent.dataset.accent).toBe("false");
    expect(accent.style.getPropertyValue("--side-tab-accent")).toBe(
      "transparent",
    );
  });

  it("shows a neutral tile and a transparent accent while the title generates, ignoring an available tint", () => {
    const row = renderRow({
      variant: "collapsed",
      tint: "#22aa66",
      tile: { kind: "generating" },
    });
    expect(row.dataset.tileKind).toBe("generating");
    const chip = byTestId(row, "side-tab-monogram-chip");
    expect(hasClasses(chip, SIDE_TAB_COLORLESS_TILE_CLASS)).toBe(true);
    expect(hasClasses(chip, SIDE_TAB_TINT_FILL_CLASS)).toBe(false);
    const accent = byTestId(row, "side-tab-accent");
    expect(accent.dataset.accent).toBe("false");
    expect(accent.style.getPropertyValue("--side-tab-accent")).toBe(
      "transparent",
    );
    const spinner = screen.getByTestId("side-tab-tile-generating");
    expect(spinner.classList.contains("text-muted-foreground")).toBe(true);
    expect(row.textContent).not.toContain("FL");
  });

  it("puts the one badge on the tile", () => {
    const row = renderRow({ variant: "collapsed", badge: "approval" });
    expect(byTestId(row, "side-tab-rail-badge").dataset.kind).toBe("approval");
    cleanup();
    const quiet = renderRow({ variant: "collapsed", badge: null });
    expect(
      quiet.querySelector('[data-testid="side-tab-rail-badge"]'),
    ).toBeNull();
  });

  it("mounts the meter under the monogram, empty or not", () => {
    const empty = renderRow({
      variant: "collapsed",
      agents: agents(0, 0, "covered"),
    });
    const emptyMeter = byTestId(empty, "side-tab-meter");
    expect(emptyMeter.getAttribute("role")).toBeNull();
    cleanup();

    const busy = renderRow({
      variant: "collapsed",
      agents: agents(2, 1, "covered"),
    });
    const busyMeter = byTestId(busy, "side-tab-meter");
    expect(busyMeter.querySelectorAll("[data-pip]")).toHaveLength(3);
  });

  it("opens the hover card body on the content-facing side", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const [edge, side] of [
      ["left", "right"],
      ["right", "left"],
    ] as const) {
      render(
        <ColumnEdgeContext.Provider value={edge}>
          <SideTabRow {...baseProps()} variant="collapsed" />
        </ColumnEdgeContext.Provider>,
      );
      dwell(screen.getByTestId(ROW_TEST_ID));
      const card = hoverCard();
      expect(card?.textContent).toBe("Fix login");
      expect(card?.dataset.side).toBe(side);
      expect(card?.dataset.align).toBe("start");
      cleanup();
    }
  });

  it("falls back to right/center outside a column", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SideTabRow {...baseProps()} variant="collapsed" />);
    dwell(screen.getByTestId(ROW_TEST_ID));
    const card = hoverCard();
    expect(card?.dataset.side).toBe("right");
    expect(card?.dataset.align).toBe("center");
  });

  it.each([
    ["the drag source", { dragSource: true }],
    ["a drop target", { dropIndicator: "before" }],
    ["a pair target", { pairPreview: "left" }],
  ] as const)("keeps the hover card closed on %s", (_name, dragState) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const row = renderRow({ variant: "collapsed", ...dragState });
    dwell(row);
    expect(hoverCard()).toBeNull();
  });

  it("keeps the same row element when the variant changes", () => {
    const ref = createRef<HTMLDivElement>();
    const { rerender } = render(
      <SideTabRow {...baseProps()} frame={rowFrame({ ref })} />,
    );
    const expandedRow = ref.current;
    rerender(
      <SideTabRow
        {...baseProps()}
        variant="collapsed"
        frame={rowFrame({ ref })}
      />,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(expandedRow);
    expect(ref.current?.dataset.sideTab).toBe("collapsed");
  });
});

describe("SideTabRow entry pulse", () => {
  function renderPulse(overrides: Partial<SideTabRowProps>): {
    readonly row: HTMLElement;
    readonly rerender: (next: ReactNode) => void;
  } {
    const utils = render(<SideTabRow {...baseProps()} {...overrides} />);
    return { row: screen.getByTestId(ROW_TEST_ID), rerender: utils.rerender };
  }

  it("does not pulse on mount, even with a waiting badge already set", () => {
    const { row } = renderPulse({ badge: "approval" });
    expect(row.dataset.waitingPulse).toBeUndefined();
  });

  it.each(["approval", "reply"] as const)(
    "pulses when the badge transitions from none into %s",
    (badge) => {
      const { row, rerender } = renderPulse({ badge: null });
      expect(row.dataset.waitingPulse).toBeUndefined();
      rerender(<SideTabRow {...baseProps()} badge={badge} />);
      expect(row.dataset.waitingPulse).toBe("true");
    },
  );

  it("clears on its own animationend event, and ignores another animation's", () => {
    const { row, rerender } = renderPulse({ badge: null });
    rerender(<SideTabRow {...baseProps()} badge="approval" />);
    expect(row.dataset.waitingPulse).toBe("true");

    fireWaitingPulseAnimationEnd(row, "some-other-animation");
    expect(row.dataset.waitingPulse).toBe("true");

    fireWaitingPulseAnimationEnd(row, "side-strip-waiting-pulse");
    expect(row.dataset.waitingPulse).toBeUndefined();
  });

  it.each(["failed", "unread"] as const)(
    "never pulses for a %s badge",
    (badge) => {
      const { row, rerender } = renderPulse({ badge: null });
      rerender(<SideTabRow {...baseProps()} badge={badge} />);
      expect(row.dataset.waitingPulse).toBeUndefined();
    },
  );

  it("does not pulse again on a later re-render while still waiting", () => {
    const { row, rerender } = renderPulse({ badge: null });
    rerender(<SideTabRow {...baseProps()} badge="approval" />);
    fireWaitingPulseAnimationEnd(row, "side-strip-waiting-pulse");
    expect(row.dataset.waitingPulse).toBeUndefined();

    rerender(<SideTabRow {...baseProps()} badge="approval" active />);
    expect(row.dataset.waitingPulse).toBeUndefined();
  });

  it("does not pulse when motion is disabled", () => {
    useThemeLibraryStore
      .getState()
      .setAppearancePreference({ panelAnimations: false });
    const { row, rerender } = renderPulse({ badge: null });
    rerender(<SideTabRow {...baseProps()} badge="approval" />);
    expect(row.dataset.waitingPulse).toBeUndefined();
  });
});

describe("SideTabRow session row", () => {
  it("fills the active session row and keeps its marker lit", () => {
    const row = renderRow({ session: "active", active: true, tint: "#f5a524" });
    expect(hasClasses(row, SIDE_TAB_SESSION_ACTIVE_CLASS)).toBe(true);
    expect(hasClasses(row, SESSION_TAB_LABEL_CLASS)).toBe(true);
    expect(hasClasses(row, SIDE_TAB_ACTIVE_CLASS)).toBe(false);
    const marker = row.querySelector<HTMLElement>("[data-layout-session-tab]");
    expect(marker?.dataset.layoutSessionTab).toBe("filled");
    expect(marker?.dataset.orientation).toBe("vertical");
  });

  it("carries the resting cap in the tab colour", () => {
    const row = renderRow({ session: "rest", tint: "#f5a524" });
    const marker = row.querySelector<HTMLElement>("[data-layout-session-tab]");
    expect(marker?.dataset.layoutSessionTab).toBe("rest");
    expect(marker?.dataset.orientation).toBe("vertical");
    expect(marker?.style.getPropertyValue("--layout-session-tab-color")).toBe(
      "#f5a524",
    );
    expect(hasClasses(row, SIDE_TAB_SESSION_ACTIVE_CLASS)).toBe(false);
  });

  it("renders no marker on an ordinary tab", () => {
    const row = renderRow({ session: null });
    expect(row.querySelector("[data-layout-session-tab]")).toBeNull();
  });
});

describe("SideTabRow drag states", () => {
  it.each([
    ["before", "-top-0.5"],
    ["after", "-bottom-0.5"],
  ] as const)("draws the %s drop line at the row edge", (side, edgeClass) => {
    const row = renderRow({ dropIndicator: side });
    const indicator = row.querySelector<HTMLElement>(
      '[data-testid="tab-drop-indicator"]',
    );
    expect(indicator?.dataset.side).toBe(side);
    expect(indicator?.classList.contains(edgeClass)).toBe(true);
    expect(indicator?.firstElementChild?.classList.contains("h-0.5")).toBe(
      true,
    );
  });

  it.each([
    ["left", "top-1 bottom-1/2"],
    ["right", "top-1/2 bottom-1"],
  ] as const)("highlights the %s pair-preview half", (side, halfClasses) => {
    const row = renderRow({ pairPreview: side });
    const preview = row.querySelector<HTMLElement>(
      '[data-testid="side-tab-pair-preview"]',
    );
    expect(preview?.dataset.side).toBe(side);
    expect(preview !== null && hasClasses(preview, halfClasses)).toBe(true);
    expect(
      preview !== null &&
        hasClasses(preview, "bg-primary/20 ring-2 ring-primary"),
    ).toBe(true);
  });

  it("draws neither when idle", () => {
    const row = renderRow({});
    expect(row.querySelector('[data-testid="tab-drop-indicator"]')).toBeNull();
    expect(
      row.querySelector('[data-testid="side-tab-pair-preview"]'),
    ).toBeNull();
  });

  it("hides the drag source's paint without removing it", () => {
    const row = renderRow({ dragSource: true });
    expect(row.classList.contains("opacity-0")).toBe(true);
    expect(row.querySelector('[data-testid="side-tab-title"]')).not.toBeNull();
  });
});

describe("SideTabRow frame", () => {
  it("spreads the frame's props, handlers and ref onto the row element", () => {
    const ref = createRef<HTMLDivElement>();
    const onKeyDown = vi.fn();
    const onPointerDown = vi.fn();
    render(
      <SideTabRow
        {...baseProps()}
        frame={rowFrame({
          ref,
          role: "tab",
          "aria-selected": true,
          "aria-label": "Fix login",
          tabIndex: 0,
          "data-strip-item-id": "epic:e1",
          className: "extra-frame-class",
          onKeyDown,
          onPointerDown,
        })}
      />,
    );
    const row = screen.getByRole("tab", { name: "Fix login" });
    expect(row).toBe(ref.current);
    expect(row.dataset.testid).toBe(ROW_TEST_ID);
    expect(row.dataset.stripItemId).toBe("epic:e1");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.tabIndex).toBe(0);
    expect(row.classList.contains("extra-frame-class")).toBe(true);
    expect(row.classList.contains("group/side-tab")).toBe(true);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.pointerDown(row);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });
});

describe("SideSplitRowPair", () => {
  it.each(["expanded", "collapsed"] as const)(
    "joins two %s members in the rail capsule's container",
    (variant) => {
      const ref = createRef<HTMLDivElement>();
      const frame: Frame = {
        ref,
        "data-strip-item-id": "split:s1",
        "data-strip-item-mergeable": "false",
      };
      render(
        <SideSplitRowPair
          frame={frame}
          variant={variant}
          testId="split-tab-group-s1"
          first={<div data-testid="member-top" />}
          second={<div data-testid="member-bottom" />}
        />,
      );
      const pair = screen.getByTestId("split-tab-group-s1");
      expect(pair).toBe(ref.current);
      expect(pair.dataset.sideSplitPair).toBe(variant);
      expect(pair.dataset.stripItemMergeable).toBe("false");
      expect(hasClasses(pair, SIDE_SPLIT_PAIR_CLASS)).toBe(true);
      expect(hasClasses(pair, "rounded-xl p-0.5 flex-col")).toBe(true);
      const ids = Array.from(pair.children).map((child) =>
        child.getAttribute("data-testid"),
      );
      expect(ids).toEqual([
        "member-top",
        "side-split-row-pair-seam",
        "member-bottom",
      ]);
      const hairline = screen.getByTestId(
        "side-split-row-pair-seam",
      ).firstElementChild;
      expect(
        hairline !== null && hasClasses(hairline, "h-px bg-border/60"),
      ).toBe(true);
      expect(
        hairline !== null &&
          hasClasses(
            hairline,
            variant === "expanded"
              ? SIDE_SPLIT_PAIR_EXPANDED_HAIRLINE_CLASS
              : SIDE_SPLIT_PAIR_COLLAPSED_HAIRLINE_CLASS,
          ),
      ).toBe(true);
    },
  );
});
