import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import {
  noteFromStroke,
  penOutline,
  resizedNote,
  type CanvasStroke,
} from "../canvas-geometry";
import { noteDimensions } from "../canvas-model";

const penPointsSchema = z.array(z.tuple([z.number(), z.number(), z.number()]));

function stroke(
  start: { x: number; y: number },
  end: { x: number; y: number },
): CanvasStroke {
  return {
    start,
    end,
    points: [
      [start.x, start.y, 0.5],
      [end.x, end.y, 0.5],
    ],
  };
}

/** Which way an arrow points on each axis, regardless of where its box sits. */
function direction(note: CanvasNote): { x: number; y: number } {
  return {
    x: Math.sign((note.x2 ?? 0) - (note.x ?? 0)),
    y: Math.sign((note.y2 ?? 0) - (note.y ?? 0)),
  };
}

describe("noteFromStroke lines and arrows", () => {
  it("keeps the dragged start and end of an arrow drawn down and right", () => {
    const note = noteFromStroke(
      "arrow",
      stroke({ x: 10, y: 20 }, { x: 110, y: 90 }),
    );
    expect(note).toMatchObject({
      type: "arrow",
      x: 10,
      y: 20,
      x2: 110,
      y2: 90,
    });
  });

  it("keeps the orientation of an arrow drawn up and left", () => {
    const note = noteFromStroke(
      "arrow",
      stroke({ x: 110, y: 90 }, { x: 10, y: 20 }),
    );
    expect(note).toMatchObject({ x: 110, y: 90, x2: 10, y2: 20 });
    expect(direction(note)).toEqual({ x: -1, y: -1 });
  });

  it("keeps a mixed direction when only one axis is reversed", () => {
    const note = noteFromStroke(
      "line",
      stroke({ x: 10, y: 90 }, { x: 110, y: 20 }),
    );
    expect(direction(note)).toEqual({ x: 1, y: -1 });
  });

  it("sizes the box to the stroke's extent", () => {
    const note = noteFromStroke(
      "arrow",
      stroke({ x: 110, y: 90 }, { x: 10, y: 20 }),
    );
    expect(noteDimensions(note)).toEqual({ width: 100, height: 70 });
  });

  it("gives a horizontal line a drawable height and no vertical drift", () => {
    const note = noteFromStroke(
      "line",
      stroke({ x: 10, y: 50 }, { x: 210, y: 50 }),
    );
    expect(note.y2).toBe(note.y);
    expect(note.h ?? 0).toBeGreaterThanOrEqual(12);
    expect(note.w).toBe(200);
  });

  it("gives a vertical line a drawable width and no horizontal drift", () => {
    const note = noteFromStroke(
      "line",
      stroke({ x: 40, y: 10 }, { x: 40, y: 310 }),
    );
    expect(note.x2).toBe(note.x);
    expect(note.w ?? 0).toBeGreaterThanOrEqual(12);
    expect(note.h).toBe(300);
  });
});

describe("noteFromStroke boxes and text", () => {
  it("places a rectangle at its top-left corner whichever way it was dragged", () => {
    const forward = noteFromStroke(
      "rect",
      stroke({ x: 10, y: 20 }, { x: 110, y: 90 }),
    );
    const backward = noteFromStroke(
      "rect",
      stroke({ x: 110, y: 90 }, { x: 10, y: 20 }),
    );
    expect(backward).toEqual(forward);
    expect(forward).toMatchObject({
      type: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 70,
    });
  });

  it("turns a tap into a usable default-sized note instead of a speck", () => {
    const tap = stroke({ x: 300, y: 300 }, { x: 301, y: 300 });
    const sticky = noteFromStroke("sticky", tap);
    expect(sticky.w ?? 0).toBeGreaterThan(100);
    expect(sticky.h ?? 0).toBeGreaterThan(100);
    expect(sticky.text).toBe("");
    const title = noteFromStroke("title", tap);
    expect(title.w ?? 0).toBeGreaterThan(sticky.w ?? 0);
    // A new title starts empty so the editor can show its placeholder instead
    // of a literal "Title" the person has to select and delete.
    expect(title.text).toBe("");
  });
});

describe("pen strokes", () => {
  const drawn: CanvasStroke = {
    start: { x: 500, y: 400 },
    end: { x: 560, y: 450 },
    points: [
      [500, 400, 0.5],
      [530, 440, 0.6],
      [560, 450, 0.5],
    ],
  };

  it("stores points relative to the note so moving the note moves the ink", () => {
    const note = noteFromStroke("pen", drawn);
    expect(note).toMatchObject({ type: "pen", x: 500, y: 400 });
    const local = penPointsSchema.parse(JSON.parse(note.points ?? "[]"));
    expect(local.map(([x, y]) => [x, y])).toEqual([
      [0, 0],
      [30, 40],
      [60, 50],
    ]);
    expect(note.w).toBe(60);
    expect(note.h).toBe(50);
  });

  it("offsets from the smallest point even when the stroke starts in the middle", () => {
    const note = noteFromStroke("pen", {
      ...drawn,
      points: [
        [530, 440, 0.5],
        [500, 450, 0.5],
        [560, 400, 0.5],
      ],
    });
    expect(note).toMatchObject({ x: 500, y: 400 });
    const local = penPointsSchema.parse(JSON.parse(note.points ?? "[]"));
    expect(Math.min(...local.map(([x]) => x))).toBe(0);
    expect(Math.min(...local.map(([, y]) => y))).toBe(0);
  });

  it("keeps a single tap drawable with finite geometry", () => {
    const note = noteFromStroke("pen", {
      start: { x: 70, y: 80 },
      end: { x: 70, y: 80 },
      points: [[70, 80, 0.5]],
    });
    expect(note.w ?? 0).toBeGreaterThanOrEqual(12);
    expect(note.h ?? 0).toBeGreaterThanOrEqual(12);

    const outline = penOutline(note.points, note.size ?? 4);
    expect(Number.isFinite(outline.width)).toBe(true);
    expect(Number.isFinite(outline.height)).toBe(true);
    expect(outline.path).not.toMatch(/NaN|Infinity/);
    // The note is drawn into a viewBox of this size, so a viewBox smaller than
    // the note's minimum extent would scale the tap up.
    expect(outline.width).toBeGreaterThanOrEqual(12);
    expect(outline.height).toBeGreaterThanOrEqual(12);
  });

  it("reads back the outline of a stroke it wrote", () => {
    const note = noteFromStroke("pen", drawn);
    const outline = penOutline(note.points, note.size ?? 4);
    expect(outline.path.startsWith("M ")).toBe(true);
    expect(outline.path).not.toMatch(/NaN|Infinity/);
    expect(outline.width).toBe(60);
    expect(outline.height).toBe(50);
  });
});

describe("penOutline rejects bad input", () => {
  const empty = { path: "", width: 1, height: 1 };

  it.each([
    ["missing", undefined],
    ["an empty stroke", "[]"],
    ["text that is not JSON", "not json"],
    ["something other than a list", '{"x":1}'],
    ["points of the wrong shape", "[[1,2]]"],
    ["points that are not numbers", '[["a","b","c"]]'],
  ])("returns an empty outline for %s", (_label, points) => {
    expect(penOutline(points, 4)).toEqual(empty);
  });

  it("returns an empty outline for more points than the schema allows", () => {
    const tooMany = JSON.stringify(
      Array.from({ length: 20001 }, (_, index) => [index, index, 0.5]),
    );
    expect(penOutline(tooMany, 4)).toEqual(empty);
  });
});

describe("resizedNote", () => {
  const frame = { x: 100, y: 200, width: 50, height: 30 };

  it("moves and resizes a plain note without inventing endpoints", () => {
    const resized = resizedNote(
      { type: "sticky", x: 0, y: 0, text: "hi" },
      frame,
    );
    expect(resized).toEqual({ x: 100, y: 200, w: 50, h: 30 });
  });

  it("maps a forward arrow onto the new frame start to end", () => {
    const resized = resizedNote(
      { type: "arrow", x: 0, y: 0, x2: 10, y2: 10 },
      frame,
    );
    expect(resized).toMatchObject({ x: 100, y: 200, x2: 150, y2: 230 });
  });

  it("keeps a reversed arrow pointing the same way", () => {
    const resized = resizedNote(
      { type: "arrow", x: 10, y: 10, x2: 0, y2: 0 },
      frame,
    );
    expect(resized).toMatchObject({ x: 150, y: 230, x2: 100, y2: 200 });
  });

  it("keeps a half-reversed line reversed only on that axis", () => {
    const original: CanvasNote = { type: "line", x: 0, y: 10, x2: 10, y2: 0 };
    const resized = resizedNote(original, frame);
    expect(direction(resized)).toEqual(direction(original));
    expect(resized).toMatchObject({ x: 100, y: 230, x2: 150, y2: 200 });
  });

  it("keeps a horizontal line horizontal and a vertical line vertical", () => {
    const horizontal = resizedNote(
      { type: "line", x: 10, y: 50, x2: 210, y2: 50 },
      { x: 100, y: 200, width: 80, height: 12 },
    );
    expect(horizontal.y2).toBe(horizontal.y);
    expect(horizontal.x2).not.toBe(horizontal.x);

    const reversedHorizontal = resizedNote(
      { type: "arrow", x: 210, y: 50, x2: 10, y2: 50 },
      { x: 100, y: 200, width: 80, height: 12 },
    );
    expect(reversedHorizontal.y2).toBe(reversedHorizontal.y);
    expect(direction(reversedHorizontal).x).toBe(-1);

    const vertical = resizedNote(
      { type: "line", x: 40, y: 10, x2: 40, y2: 310 },
      { x: 100, y: 200, width: 12, height: 90 },
    );
    expect(vertical.x2).toBe(vertical.x);
    expect(vertical.y2).not.toBe(vertical.y);
  });

  it("preserves direction for every orientation", () => {
    for (const [x2, y2] of [
      [10, 10],
      [-10, 10],
      [10, -10],
      [-10, -10],
    ]) {
      const original: CanvasNote = {
        type: "arrow",
        x: 50,
        y: 50,
        x2: 50 + x2,
        y2: 50 + y2,
      };
      expect(direction(resizedNote(original, frame))).toEqual(
        direction(original),
      );
    }
  });

  it("is a no-op when the frame is the arrow's own bounding box", () => {
    const original: CanvasNote = {
      type: "arrow",
      x: 110,
      y: 90,
      x2: 10,
      y2: 20,
    };
    const { width, height } = noteDimensions(original);
    const resized = resizedNote(original, { x: 10, y: 20, width, height });
    expect(resized).toMatchObject({ x: 110, y: 90, x2: 10, y2: 20 });
  });
});

describe("noteDimensions", () => {
  it("measures a line by its endpoints in either direction", () => {
    const forward = noteDimensions({
      type: "line",
      x: 10,
      y: 20,
      x2: 110,
      y2: 70,
    });
    const backward = noteDimensions({
      type: "line",
      x: 110,
      y: 70,
      x2: 10,
      y2: 20,
    });
    expect(forward).toEqual({ width: 100, height: 50 });
    expect(backward).toEqual(forward);
  });

  it("never collapses a flat or upright line below a drawable size", () => {
    expect(
      noteDimensions({ type: "line", x: 0, y: 5, x2: 100, y2: 5 }).height,
    ).toBeGreaterThanOrEqual(12);
    expect(
      noteDimensions({ type: "arrow", x: 5, y: 0, x2: 5, y2: 100 }).width,
    ).toBeGreaterThanOrEqual(12);
  });

  it("ignores the stored box of a line when it has endpoints", () => {
    expect(
      noteDimensions({
        type: "arrow",
        x: 0,
        y: 0,
        x2: 40,
        y2: 30,
        w: 999,
        h: 999,
      }),
    ).toEqual({ width: 40, height: 30 });
  });

  it("uses the stored box for other notes and fills in defaults", () => {
    expect(
      noteDimensions({ type: "rect", x: 0, y: 0, w: 321, h: 123 }),
    ).toEqual({ width: 321, height: 123 });
    const sticky = noteDimensions({ type: "sticky", x: 0, y: 0 });
    const title = noteDimensions({ type: "title", x: 0, y: 0 });
    expect(title.width).toBeGreaterThan(sticky.width);
    expect(title.height).toBeLessThan(sticky.height);
  });

  it("clamps a degenerate box to a drawable minimum", () => {
    expect(noteDimensions({ type: "rect", x: 0, y: 0, w: 0, h: 1 })).toEqual({
      width: 12,
      height: 12,
    });
  });
});
