import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armLayoutDrag,
  cancelLayoutDrag,
  holdLayoutDrag,
  layoutDragActive,
} from "@/components/layout-editor/canvas/drag-engine";

/**
 * The DOM driver, against three stacked rows with measured boxes.
 *
 * jsdom lays nothing out, so each row is handed the rect it would have had:
 * 20px tall, 4px apart, tops 0 / 24 / 48. Everything the engine decides is
 * arithmetic on those numbers, so the rects being stubbed costs the test
 * nothing - what it exercises is the wiring the pure model cannot: the
 * listeners, the frame loop, the transforms and the single commit.
 */

const ROW_HEIGHT = 20;
const ROW_GAP = 4;

interface Fixture {
  readonly container: HTMLElement;
  readonly rows: ReadonlyArray<HTMLElement>;
}

function mountRows(count: number): Fixture {
  const container = document.createElement("div");
  document.body.append(container);
  const rows = Array.from({ length: count }, (_unused, index) => {
    const row = document.createElement("div");
    row.dataset.row = String(index);
    const top = index * (ROW_HEIGHT + ROW_GAP);
    row.getBoundingClientRect = () => ({
      left: 0,
      top,
      right: 200,
      bottom: top + ROW_HEIGHT,
      width: 200,
      height: ROW_HEIGHT,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    row.setPointerCapture = () => undefined;
    row.releasePointerCapture = () => undefined;
    row.hasPointerCapture = () => true;
    container.append(row);
    return row;
  });
  return { container, rows };
}

/** Arms a drag on one row from a real `pointerdown`, the way a surface does. */
function press(
  fixture: Fixture,
  index: number,
  onDrop: (f: number, t: number) => void,
): void {
  const row = fixture.rows[index];
  const arm = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return;
    armLayoutDrag({
      event,
      resolve: () => ({ items: fixture.rows, index, clamp: null }),
      onDrop,
    });
  };
  row.addEventListener("pointerdown", arm);
  row.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
    }),
  );
  row.removeEventListener("pointerdown", arm);
}

function movePointerTo(clientY: number): void {
  window.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY }),
  );
}

function releasePointer(): void {
  window.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
  );
}

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
}

function translationOf(node: HTMLElement): number {
  const match = /translateY\((-?[\d.]+)px\)/.exec(node.style.transform);
  return match === null ? 0 : Number(match[1]);
}

beforeEach(() => {
  document.documentElement.setAttribute("data-reduce-panel-motion", "");
});

afterEach(() => {
  cancelLayoutDrag();
  document.documentElement.removeAttribute("data-reduce-panel-motion");
  document.body.replaceChildren();
});

describe("the drag engine", () => {
  it("leaves a press that never travelled alone", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(4);
    await frames(2);

    expect(layoutDragActive()).toBe(true);
    expect(fixture.rows[0].hasAttribute("data-layout-dragging")).toBe(false);

    releasePointer();

    expect(layoutDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("reflows the siblings live and writes nothing until the release", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);

    expect(fixture.rows[0].getAttribute("data-layout-dragging")).toBe("1");

    // Far enough for the first row's centre to pass the second row's.
    movePointerTo(40);
    await frames(2);

    // The row that has been passed has stepped up by the dragged row's own
    // footprint; the third has not moved, and nothing has been committed.
    expect(translationOf(fixture.rows[1])).toBe(-(ROW_HEIGHT + ROW_GAP));
    expect(translationOf(fixture.rows[2])).toBe(0);
    expect(onDrop).not.toHaveBeenCalled();

    releasePointer();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(0, 1);
  });

  it("hands the element back exactly as it found it", async () => {
    const fixture = mountRows(3);

    press(fixture, 0, vi.fn());
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);
    releasePointer();

    for (const row of fixture.rows) {
      expect(row.style.transform).toBe("");
      expect(row.style.willChange).toBe("");
    }
    expect(fixture.rows[0].hasAttribute("data-layout-dragging")).toBe(false);
    expect(layoutDragActive()).toBe(false);
  });

  it("commits nothing when the member is let go where it started", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);
    movePointerTo(20);
    await frames(2);
    releasePointer();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("puts the member back when the system takes the pointer away", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);

    window.dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }),
    );

    expect(layoutDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    for (const row of fixture.rows) expect(row.style.transform).toBe("");
  });

  it("stops on a cancel, writes nothing, and leaves no transform behind", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);

    cancelLayoutDrag();

    expect(layoutDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    for (const row of fixture.rows) expect(row.style.transform).toBe("");

    // The listeners went with it: a pointer that keeps moving moves nothing.
    movePointerTo(80);
    await frames(2);
    for (const row of fixture.rows) expect(row.style.transform).toBe("");
  });

  it("rides the release spring home before it commits, under full motion", async () => {
    document.documentElement.removeAttribute("data-reduce-panel-motion");
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);
    releasePointer();

    // The pointer has gone, the element has not arrived: the drop is the end
    // of the travel, not the end of the gesture.
    expect(onDrop).not.toHaveBeenCalled();
    expect(layoutDragActive()).toBe(true);

    await frames(90);

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(0, 1);
    expect(layoutDragActive()).toBe(false);
  });

  it("ignores a second pointer that presses while one is already in hand", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);
    const carried = translationOf(fixture.rows[0]);

    // A second finger, moving the other way and letting go.
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 2,
        clientY: -200,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }),
    );
    await frames(2);

    expect(translationOf(fixture.rows[0])).toBe(carried);
    expect(layoutDragActive()).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("releases the module when the press is cancelled before it travels", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(4);
    await frames(2);
    expect(layoutDragActive()).toBe(true);

    window.dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }),
    );

    // The latch is off, so a later press can still arm one (a cancel during
    // the arm phase is the only thing that frees it before the threshold).
    expect(layoutDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();

    press(fixture, 1, onDrop);
    expect(layoutDragActive()).toBe(true);
  });

  it("eats the click the release synthesises, and only that one", async () => {
    const fixture = mountRows(3);
    const clicked = vi.fn();
    fixture.rows[0].addEventListener("click", clicked);

    press(fixture, 0, vi.fn());
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);
    releasePointer();

    fixture.rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).not.toHaveBeenCalled();

    // The next one is an ordinary click again: the row still opens its level.
    fixture.rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("ends the gesture on a scroll rather than reflowing against stale boxes", async () => {
    const fixture = mountRows(3);
    const onDrop = vi.fn();

    press(fixture, 0, onDrop);
    movePointerTo(10);
    await frames(2);
    movePointerTo(40);
    await frames(2);

    fixture.container.dispatchEvent(new Event("scroll", { bubbles: false }));

    expect(layoutDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    for (const row of fixture.rows) expect(row.style.transform).toBe("");
  });

  it("holds a pinned member inside its cluster and springs it back", async () => {
    const fixture = mountRows(3);
    const clamp = document.createElement("div");
    clamp.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 88,
      width: 200,
      height: 88,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const onDrop = vi.fn();
    const row = fixture.rows[2];
    const arm = (event: Event): void => {
      if (!(event instanceof PointerEvent)) return;
      armLayoutDrag({
        event,
        resolve: () => ({ items: fixture.rows, index: 2, clamp }),
        onDrop,
      });
    };
    row.addEventListener("pointerdown", arm);
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        button: 0,
        clientX: 0,
        clientY: 0,
      }),
    );

    movePointerTo(10);
    await frames(2);
    // 100px below the grab point, with 20px of room left in the cluster: the
    // last row's bottom is at 68 and the cluster's is at 88.
    movePointerTo(110);
    await frames(2);

    // A quarter of the 80px overshoot survives: 20 + 20 = 40, not 100.
    expect(translationOf(fixture.rows[2])).toBeCloseTo(40, 5);

    releasePointer();
  });
});

/**
 * The one-drag-slot primitive `surface-drag.ts` holds its live drag on, tested
 * directly rather than only through the surface drag that wraps it.
 */
describe("holdLayoutDrag / cancelLayoutDrag", () => {
  it("makes layoutDragActive() true, and cancelLayoutDrag() calls the stop", () => {
    const stop = vi.fn();
    let release: (() => void) | null = null;
    release = holdLayoutDrag(() => {
      stop();
      release?.();
    });

    expect(layoutDragActive()).toBe(true);

    cancelLayoutDrag();

    expect(stop).toHaveBeenCalledOnce();
    expect(layoutDragActive()).toBe(false);
  });

  it("releases the one drag slot only if it still holds it", () => {
    const firstStop = vi.fn();
    let releaseFirst: (() => void) | null = null;
    releaseFirst = holdLayoutDrag(() => {
      firstStop();
      releaseFirst?.();
    });

    // A second drag takes the one slot before the first caller lets go.
    const secondStop = vi.fn();
    let releaseSecond: (() => void) | null = null;
    releaseSecond = holdLayoutDrag(() => {
      secondStop();
      releaseSecond?.();
    });

    releaseFirst();

    expect(layoutDragActive()).toBe(true);
    expect(secondStop).not.toHaveBeenCalled();

    cancelLayoutDrag();

    expect(secondStop).toHaveBeenCalledOnce();
    expect(layoutDragActive()).toBe(false);
  });
});
