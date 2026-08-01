import { afterEach, describe, expect, it, vi } from "vitest";
import { chatBottomOverlayClampedRect } from "@/components/chat/chat-scroll-region-geometry";

describe("chatBottomOverlayClampedRect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pulls the bottom edge up by the overlay inset and shrinks height", () => {
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      width: 400,
      height: 600,
      top: 20,
      left: 10,
      right: 410,
      bottom: 620,
      toJSON: () => ({}),
    });

    expect(chatBottomOverlayClampedRect(el, 80)).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 520,
      top: 20,
      left: 10,
      right: 410,
      bottom: 540,
    });
  });

  it("is a no-op geometry copy when the inset is 0", () => {
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 200,
      top: 0,
      left: 0,
      right: 100,
      bottom: 200,
      toJSON: () => ({}),
    });

    expect(chatBottomOverlayClampedRect(el, 0)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 200,
      top: 0,
      left: 0,
      right: 100,
      bottom: 200,
    });
  });

  it("clamps bottom to top (never below it, never a negative height) when inset exceeds the rect", () => {
    const el = document.createElement("div");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      toJSON: () => ({}),
    });

    // Inset (500) far exceeds the rect's own height (100): `bottom` must
    // clamp to `top` (0), not go negative - a rect with `bottom` below `top`
    // is internally inconsistent even though `height` is separately
    // clamped to 0.
    const clamped = chatBottomOverlayClampedRect(el, 500);
    expect(clamped.height).toBe(0);
    expect(clamped.bottom).toBe(0);
    expect(clamped.bottom).toBeGreaterThanOrEqual(clamped.top);
  });
});
