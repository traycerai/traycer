import { describe, expect, it } from "vitest";
import { computeTabDropIndex } from "@/components/epic-canvas/dnd/tab-strip-drop-preview";
import { resolveHeaderStripDropIndex } from "@/components/layout/tabs/header-tab-dnd";

describe("computeTabDropIndex", () => {
  const overRect = { left: 100, top: 0, width: 80, height: 36 };

  it("inserts before the hovered tab when the dragged chip center is left of its center", () => {
    expect(
      computeTabDropIndex({
        overIndex: 2,
        activeRect: { left: 60, top: 0, width: 60, height: 36 },
        overRect,
      }),
    ).toBe(2);
  });

  it("inserts after the hovered tab when the dragged chip center is right of its center", () => {
    expect(
      computeTabDropIndex({
        overIndex: 2,
        activeRect: { left: 140, top: 0, width: 60, height: 36 },
        overRect,
      }),
    ).toBe(3);
  });

  it("falls back to the hovered index for zero-width rects", () => {
    expect(
      computeTabDropIndex({
        overIndex: 4,
        activeRect: { left: 0, top: 0, width: 60, height: 36 },
        overRect: { left: 100, top: 0, width: 0, height: 36 },
      }),
    ).toBe(4);
  });
});

describe("resolveHeaderStripDropIndex", () => {
  const slotRect = { left: 100, top: 0, width: 110, height: 42 };

  it("resolves before/after the hovered slot by pointer midpoint", () => {
    expect(
      resolveHeaderStripDropIndex({
        slot: { kind: "header-tab-slot", index: 1, isTrailing: false },
        pointerX: 120,
        slotRect,
        sourceIndex: null,
      }),
    ).toBe(1);
    expect(
      resolveHeaderStripDropIndex({
        slot: { kind: "header-tab-slot", index: 1, isTrailing: false },
        pointerX: 200,
        slotRect,
        sourceIndex: null,
      }),
    ).toBe(2);
  });

  it("uses the trailing slot index verbatim", () => {
    expect(
      resolveHeaderStripDropIndex({
        slot: { kind: "header-tab-slot", index: 3, isTrailing: true },
        pointerX: 9999,
        slotRect,
        sourceIndex: null,
      }),
    ).toBe(3);
  });

  it("suppresses reorder no-op slots for header-tab sources", () => {
    expect(
      resolveHeaderStripDropIndex({
        slot: { kind: "header-tab-slot", index: 1, isTrailing: false },
        pointerX: 120,
        slotRect,
        sourceIndex: 1,
      }),
    ).toBeNull();
    expect(
      resolveHeaderStripDropIndex({
        slot: { kind: "header-tab-slot", index: 1, isTrailing: false },
        pointerX: 200,
        slotRect,
        sourceIndex: 1,
      }),
    ).toBeNull();
    expect(
      resolveHeaderStripDropIndex({
        slot: { kind: "header-tab-slot", index: 3, isTrailing: false },
        pointerX: 320,
        slotRect: { left: 300, top: 0, width: 110, height: 42 },
        sourceIndex: 1,
      }),
    ).toBe(3);
  });
});
