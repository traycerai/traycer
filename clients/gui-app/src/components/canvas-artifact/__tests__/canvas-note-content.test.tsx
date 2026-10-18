import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import { CanvasNoteContent } from "../canvas-note-content";
import { noteDimensions } from "../canvas-model";

interface DrawnLine {
  readonly viewBox: { readonly width: number; readonly height: number };
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly arrowhead: boolean;
}

function numberAttribute(element: Element, name: string): number {
  const value = Number(element.getAttribute(name));
  if (!Number.isFinite(value)) throw new Error(`${name} is not a number`);
  return value;
}

function drawLine(note: CanvasNote): DrawnLine {
  render(
    <CanvasNoteContent
      note={note}
      imageSource={null}
      onCommit={() => undefined}
    />,
  );
  const svg = screen.getByLabelText(note.type ?? "line");
  const line = svg.querySelector("line");
  if (line === null) throw new Error("the note drew no line");
  const [, , width, height] = (svg.getAttribute("viewBox") ?? "")
    .split(" ")
    .map(Number);
  return {
    viewBox: { width, height },
    from: { x: numberAttribute(line, "x1"), y: numberAttribute(line, "y1") },
    to: { x: numberAttribute(line, "x2"), y: numberAttribute(line, "y2") },
    arrowhead: line.hasAttribute("marker-end"),
  };
}

afterEach(cleanup);

describe("CanvasNoteContent lines", () => {
  it("draws a diagonal from the box's top-left to its bottom-right", () => {
    const drawn = drawLine({ type: "line", x: 10, y: 20, x2: 60, y2: 60 });
    expect(drawn.viewBox).toEqual({ width: 50, height: 40 });
    expect(drawn.from).toEqual({ x: 0, y: 0 });
    expect(drawn.to).toEqual({ x: 50, y: 40 });
  });

  it("starts a reversed diagonal at the far corner so the direction survives", () => {
    const drawn = drawLine({ type: "line", x: 60, y: 60, x2: 10, y2: 20 });
    expect(drawn.from).toEqual({ x: 50, y: 40 });
    expect(drawn.to).toEqual({ x: 0, y: 0 });
  });

  it("flips only the axis that is reversed", () => {
    const drawn = drawLine({ type: "line", x: 10, y: 60, x2: 60, y2: 20 });
    expect(drawn.from).toEqual({ x: 0, y: 40 });
    expect(drawn.to).toEqual({ x: 50, y: 0 });
  });

  it("keeps a horizontal line flat inside its drawable box", () => {
    const drawn = drawLine({ type: "line", x: 10, y: 50, x2: 210, y2: 50 });
    // The flat axis stays on the line's own coordinate (the box origin), not
    // on the centre of the minimum-height box, which would draw it 6 lower.
    expect(drawn.from.y).toBe(0);
    expect(drawn.to.y).toBe(0);
    expect(drawn.to.x - drawn.from.x).toBe(200);
  });

  it("keeps a vertical line upright inside its drawable box", () => {
    const drawn = drawLine({ type: "line", x: 40, y: 10, x2: 40, y2: 310 });
    expect(drawn.from.x).toBe(0);
    expect(drawn.to.x).toBe(0);
    expect(drawn.to.y - drawn.from.y).toBe(300);
  });

  it("keeps a reversed horizontal line pointing left", () => {
    const drawn = drawLine({ type: "line", x: 210, y: 50, x2: 10, y2: 50 });
    expect(drawn.from.y).toBe(0);
    expect(drawn.to.y).toBe(0);
    expect(drawn.to.x - drawn.from.x).toBe(-200);
  });

  it("keeps the true slope of a shallow 100 by 1 line", () => {
    const drawn = drawLine({ type: "line", x: 0, y: 0, x2: 100, y2: 1 });
    expect(drawn.to.x - drawn.from.x).toBe(100);
    expect(drawn.to.y - drawn.from.y).toBe(1);
  });

  it("keeps the true slope and direction of a reversed shallow line", () => {
    const drawn = drawLine({ type: "line", x: 100, y: 1, x2: 0, y2: 0 });
    expect(drawn.to.x - drawn.from.x).toBe(-100);
    expect(drawn.to.y - drawn.from.y).toBe(-1);
  });

  it("keeps every drawn point inside the view box", () => {
    for (const note of [
      { type: "line", x: 0, y: 0, x2: 100, y2: 1 },
      { type: "arrow", x: 100, y: 1, x2: 0, y2: 0 },
      { type: "line", x: 0, y: 5, x2: 100, y2: 5 },
      { type: "arrow", x: 5, y: 0, x2: 5, y2: 100 },
    ] satisfies CanvasNote[]) {
      cleanup();
      const { from, to, viewBox } = drawLine(note);
      for (const point of [from, to]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(viewBox.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(viewBox.height);
      }
    }
  });

  it("sizes the view box like the node that hosts it", () => {
    const note: CanvasNote = { type: "arrow", x: 110, y: 90, x2: 10, y2: 20 };
    const drawn = drawLine(note);
    const { width, height } = noteDimensions(note);
    expect(drawn.viewBox).toEqual({ width, height });
  });

  it("gives only arrows an arrowhead", () => {
    expect(
      drawLine({ type: "arrow", x: 0, y: 0, x2: 50, y2: 50 }).arrowhead,
    ).toBe(true);
    cleanup();
    expect(
      drawLine({ type: "line", x: 0, y: 0, x2: 50, y2: 50 }).arrowhead,
    ).toBe(false);
  });
});
