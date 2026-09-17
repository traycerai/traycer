import {
  computePosition,
  platform,
  type Platform,
  type Rect,
} from "@floating-ui/dom";
import { describe, expect, it } from "vitest";

import { composerMenuMiddleware } from "../composer-menu-middleware";

// A phone-sized layout viewport. jsdom has no layout, so the geometry is
// handed to floating-ui through a platform that answers from plain rects -
// the middleware and floating-ui's own arithmetic are what run for real.
const VIEWPORT: Rect = { x: 0, y: 0, width: 390, height: 844 };
const PADDING = 8;
const GAP = 6;

interface Geometry {
  readonly caret: Rect;
  readonly menu: { readonly width: number; readonly height: number };
}

function fakePlatform(geometry: Geometry): Platform {
  return {
    ...platform,
    getElementRects: () => ({
      reference: geometry.caret,
      floating: { x: 0, y: 0, ...geometry.menu },
    }),
    getClippingRect: () => VIEWPORT,
    getDimensions: () => geometry.menu,
    getOffsetParent: () => window,
    convertOffsetParentRelativeRectToViewportRelativeRect: ({ rect }) => rect,
    isRTL: () => false,
  };
}

async function place(
  placement: "bottom-start" | "top-start",
  geometry: Geometry,
): Promise<{ readonly x: number; readonly y: number }> {
  const { x, y } = await computePosition(
    { getBoundingClientRect: () => new DOMRect() },
    document.createElement("div"),
    {
      placement,
      middleware: composerMenuMiddleware(),
      platform: fakePlatform(geometry),
    },
  );
  return { x, y };
}

function caretAt(x: number, y: number): Rect {
  return { x, y, width: 0, height: 20 };
}

describe("composerMenuMiddleware", () => {
  it.each(["bottom-start", "top-start"] as const)(
    "pulls a %s menu opened near the right edge back inside the viewport",
    async (placement) => {
      const { x } = await place(placement, {
        caret: caretAt(300, 400),
        menu: { width: 350, height: 200 },
      });

      expect(x).toBeGreaterThanOrEqual(PADDING);
      expect(x).toBeLessThanOrEqual(VIEWPORT.width - 350 - PADDING);
    },
  );

  it("keeps a menu opened at the left edge off the edge by the padding", async () => {
    const { x } = await place("bottom-start", {
      caret: caretAt(0, 400),
      menu: { width: 350, height: 200 },
    });

    expect(x).toBe(PADDING);
  });

  it("leaves a menu that already fits anchored at the caret", async () => {
    const { x, y } = await place("bottom-start", {
      caret: caretAt(20, 400),
      menu: { width: 350, height: 200 },
    });

    expect(x).toBe(20);
    expect(y).toBe(400 + 20 + GAP);
  });

  it("keeps a menu taller than the room on either side of the caret inside the viewport vertically", async () => {
    // Neither side has 600px: flip settles on its best side and the vertical
    // clamp is what keeps the header and first rows reachable.
    const { y } = await place("bottom-start", {
      caret: caretAt(20, 400),
      menu: { width: 350, height: 600 },
    });

    expect(y).toBeGreaterThanOrEqual(PADDING);
    expect(y).toBeLessThanOrEqual(VIEWPORT.height - 600 - PADDING);
  });
});
