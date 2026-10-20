import "../../../../../../__tests__/test-browser-apis";
import { createRef, type RefObject } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";

import {
  SELECT_HOLD_MS,
  useTerminalTouchGestures,
} from "../use-terminal-touch-gestures";
import type { TerminalTouchTarget } from "../terminal-touch-selection";

const VIEWPORT_Y = 7;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface FakeTerm {
  readonly target: TerminalTouchTarget;
  readonly select: Mock<TerminalTouchTarget["select"]>;
}

/** An 80x24 grid painted into an 800x480 screen at the origin: 10px cells, 20px rows. */
function createTerm(): FakeTerm {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 800,
    height: 480,
    right: 800,
    bottom: 480,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  element.appendChild(screen);
  const select = vi.fn<TerminalTouchTarget["select"]>();
  const target: TerminalTouchTarget = {
    element,
    cols: 80,
    rows: 24,
    options: { wordSeparator: " " },
    buffer: { active: { viewportY: VIEWPORT_Y, getLine: () => undefined } },
    hasSelection: () => false,
    getSelection: () => "",
    clearSelection: () => undefined,
    select,
    selectAll: () => undefined,
    paste: () => undefined,
    focus: () => undefined,
  };
  return { target, select };
}

interface Harness {
  readonly mount: HTMLElement;
  readonly term: FakeTerm;
  readonly onTap: Mock<() => void>;
  readonly onLongPress: Mock<(point: { x: number; y: number }) => void>;
}

function Probe(props: {
  readonly termRef: RefObject<TerminalTouchTarget | null>;
  readonly onTap: () => void;
  readonly onLongPress: (point: { x: number; y: number }) => void;
}) {
  const mountRef = createRef<HTMLDivElement>();
  const handlers = useTerminalTouchGestures({
    termRef: props.termRef,
    mountRef,
    onTap: props.onTap,
    onLongPress: props.onLongPress,
  });
  return <div data-testid="mount" ref={mountRef} {...handlers} />;
}

function setup(): Harness & { readonly unmount: () => void } {
  const term = createTerm();
  const termRef: RefObject<TerminalTouchTarget | null> = {
    current: term.target,
  };
  const onTap = vi.fn<() => void>();
  const onLongPress = vi.fn<(point: { x: number; y: number }) => void>();
  const view = render(
    <Probe termRef={termRef} onTap={onTap} onLongPress={onLongPress} />,
  );
  return {
    mount: view.getByTestId("mount"),
    term,
    onTap,
    onLongPress,
    unmount: view.unmount,
  };
}

interface PointerInit {
  readonly x: number;
  readonly y: number;
  readonly pointerType: string;
}

function pointer(
  fire: typeof fireEvent.pointerDown,
  mount: HTMLElement,
  init: PointerInit,
): void {
  fire(mount, {
    pointerType: init.pointerType,
    isPrimary: true,
    pointerId: 1,
    clientX: init.x,
    clientY: init.y,
  });
}

const touch = (x: number, y: number): PointerInit => ({
  x,
  y,
  pointerType: "touch",
});

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useTerminalTouchGestures", () => {
  it("treats a quick release within the slop as a tap", () => {
    const { mount, term, onTap, onLongPress } = setup();
    pointer(fireEvent.pointerDown, mount, touch(100, 50));
    advance(SELECT_HOLD_MS - 50);
    pointer(fireEvent.pointerUp, mount, touch(105, 54));
    advance(1000);

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(term.select).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("selects from the held cell to the cell under the dragging finger", () => {
    const { mount, term, onTap, onLongPress } = setup();
    // Anchor: column 10, screen row 2 -> buffer row VIEWPORT_Y + 2.
    pointer(fireEvent.pointerDown, mount, touch(105, 45));
    advance(SELECT_HOLD_MS);
    pointer(fireEvent.pointerMove, mount, touch(135, 45));
    expect(term.select).toHaveBeenLastCalledWith(10, VIEWPORT_Y + 2, 4);

    pointer(fireEvent.pointerMove, mount, touch(205, 45));
    expect(term.select).toHaveBeenLastCalledWith(10, VIEWPORT_Y + 2, 11);

    pointer(fireEvent.pointerUp, mount, touch(205, 45));
    advance(1000);
    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("starts the span at the head when the finger drags above the anchor", () => {
    const { mount, term } = setup();
    // Anchor at column 10, screen row 4; head at column 10, screen row 1.
    pointer(fireEvent.pointerDown, mount, touch(105, 85));
    advance(SELECT_HOLD_MS);
    pointer(fireEvent.pointerMove, mount, touch(105, 25));

    expect(term.select).toHaveBeenLastCalledWith(
      10,
      VIEWPORT_Y + 1,
      3 * 80 + 1,
    );
  });

  it("keeps touchmove from scrolling while a selection drag is in flight", () => {
    const { mount } = setup();
    const documentListener = vi.fn();
    document.addEventListener("touchmove", documentListener);
    try {
      const idle = new Event("touchmove", { bubbles: true, cancelable: true });
      mount.dispatchEvent(idle);
      expect(idle.defaultPrevented).toBe(false);
      expect(documentListener).toHaveBeenCalledTimes(1);

      pointer(fireEvent.pointerDown, mount, touch(105, 45));
      advance(SELECT_HOLD_MS);
      pointer(fireEvent.pointerMove, mount, touch(135, 45));

      const dragging = new Event("touchmove", {
        bubbles: true,
        cancelable: true,
      });
      mount.dispatchEvent(dragging);
      expect(dragging.defaultPrevented).toBe(true);
      expect(documentListener).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("touchmove", documentListener);
    }
  });

  it("leaves a finger that moves before the select hold to scrolling", () => {
    const { mount, term, onTap, onLongPress } = setup();
    pointer(fireEvent.pointerDown, mount, touch(100, 100));
    pointer(fireEvent.pointerMove, mount, touch(100, 120));
    advance(LONG_PRESS_MS + 50);
    pointer(fireEvent.pointerMove, mount, touch(300, 300));
    pointer(fireEvent.pointerUp, mount, touch(300, 300));

    expect(term.select).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("reports a long press on release at the point the finger went down", () => {
    const { mount, term, onTap, onLongPress } = setup();
    pointer(fireEvent.pointerDown, mount, touch(120, 60));
    advance(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
    pointer(fireEvent.pointerUp, mount, touch(122, 61));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ x: 120, y: 60 });
    expect(onTap).not.toHaveBeenCalled();
    expect(term.select).not.toHaveBeenCalled();
  });

  it("ignores a mouse pointer entirely", () => {
    const { mount, term, onTap, onLongPress } = setup();
    const mouse: PointerInit = { x: 100, y: 100, pointerType: "mouse" };
    pointer(fireEvent.pointerDown, mount, mouse);
    advance(LONG_PRESS_MS + 50);
    pointer(fireEvent.pointerUp, mount, mouse);

    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(term.select).not.toHaveBeenCalled();
  });

  it("abandons the gesture on pointercancel", () => {
    const { mount, onTap, onLongPress } = setup();
    pointer(fireEvent.pointerDown, mount, touch(100, 100));
    advance(LONG_PRESS_MS);
    pointer(fireEvent.pointerCancel, mount, touch(100, 100));
    pointer(fireEvent.pointerUp, mount, touch(100, 100));
    advance(1000);

    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("fires nothing when unmounted mid-hold", () => {
    const { mount, unmount, term, onTap, onLongPress } = setup();
    pointer(fireEvent.pointerDown, mount, touch(100, 100));
    advance(SELECT_HOLD_MS - 50);
    unmount();
    advance(LONG_PRESS_MS * 2);

    expect(vi.getTimerCount()).toBe(0);
    expect(onTap).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(term.select).not.toHaveBeenCalled();
  });
});
