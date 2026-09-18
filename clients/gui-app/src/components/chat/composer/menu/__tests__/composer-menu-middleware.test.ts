import {
  computePosition,
  platform,
  type Platform,
  type Rect,
} from "@floating-ui/dom";
import { afterEach, describe, expect, it } from "vitest";

import {
  composerMenuMiddleware,
  initialComposerMenuPlacement,
  readComposerMenuReservedEdges,
  type ComposerMenuReservedEdges,
} from "../composer-menu-middleware";

// A phone-sized layout viewport. jsdom has no layout, so the geometry is
// handed to floating-ui through a platform that answers from plain rects -
// the middleware and floating-ui's own arithmetic are what run for real.
const VIEWPORT: Rect = { x: 0, y: 0, width: 390, height: 844 };
const PADDING = 8;
const GAP = 6;
const NOTHING_RESERVED: ComposerMenuReservedEdges = {
  topPx: 0,
  bottomPx: 0,
  leftPx: 0,
  rightPx: 0,
};
// An iPhone-sized software keyboard covering the bottom of the viewport.
const KEYBOARD_PX = 336;
const KEYBOARD_UP: ComposerMenuReservedEdges = {
  ...NOTHING_RESERVED,
  bottomPx: KEYBOARD_PX,
};

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

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly placement: string;
  /** The height cap the middleware wrote onto the menu, if any. */
  readonly maxHeight: string;
}

async function place(
  placement: "bottom-start" | "top-start",
  geometry: Geometry,
  reserved: ComposerMenuReservedEdges,
): Promise<Placed> {
  const menu = document.createElement("div");
  const result = await computePosition(
    { getBoundingClientRect: () => new DOMRect() },
    menu,
    {
      placement,
      middleware: composerMenuMiddleware(reserved),
      platform: fakePlatform(geometry),
    },
  );
  return {
    x: result.x,
    y: result.y,
    placement: result.placement,
    maxHeight: menu.style.maxHeight,
  };
}

function caretAt(x: number, y: number): Rect {
  return { x, y, width: 0, height: 20 };
}

describe("composerMenuMiddleware", () => {
  it.each(["bottom-start", "top-start"] as const)(
    "pulls a %s menu opened near the right edge back inside the viewport",
    async (placement) => {
      const { x } = await place(
        placement,
        {
          caret: caretAt(300, 400),
          menu: { width: 350, height: 200 },
        },
        NOTHING_RESERVED,
      );

      expect(x).toBeGreaterThanOrEqual(PADDING);
      expect(x).toBeLessThanOrEqual(VIEWPORT.width - 350 - PADDING);
    },
  );

  it("keeps a menu opened at the left edge off the edge by the padding", async () => {
    const { x } = await place(
      "bottom-start",
      {
        caret: caretAt(0, 400),
        menu: { width: 350, height: 200 },
      },
      NOTHING_RESERVED,
    );

    expect(x).toBe(PADDING);
  });

  it("leaves a menu that already fits anchored at the caret", async () => {
    const { x, y } = await place(
      "bottom-start",
      {
        caret: caretAt(20, 400),
        menu: { width: 350, height: 200 },
      },
      NOTHING_RESERVED,
    );

    expect(x).toBe(20);
    expect(y).toBe(400 + 20 + GAP);
  });

  it("keeps a menu taller than the room on either side of the caret inside the viewport vertically", async () => {
    // Neither side has 600px: flip settles on its best side and the vertical
    // clamp is what keeps the header and first rows reachable.
    const { y } = await place(
      "bottom-start",
      {
        caret: caretAt(20, 400),
        menu: { width: 350, height: 600 },
      },
      NOTHING_RESERVED,
    );

    expect(y).toBeGreaterThanOrEqual(PADDING);
    expect(y).toBeLessThanOrEqual(VIEWPORT.height - 600 - PADDING);
  });
});

describe("composerMenuMiddleware with a software keyboard up", () => {
  const keyboardTop = VIEWPORT.height - KEYBOARD_PX;

  // The keyboard's top edge is at y=508; a caret on screen sits above it.
  it("opens above a caret just over the keyboard instead of underneath it", async () => {
    const placed = await place(
      "bottom-start",
      { caret: caretAt(20, 470), menu: { width: 350, height: 300 } },
      KEYBOARD_UP,
    );

    expect(placed.placement.startsWith("top")).toBe(true);
    expect(placed.y).toBeGreaterThanOrEqual(PADDING);
    expect(placed.y + 300).toBeLessThanOrEqual(keyboardTop - PADDING);
  });

  it("opens above a caret whose room below is mostly keyboard", async () => {
    const placed = await place(
      "bottom-start",
      { caret: caretAt(20, 300), menu: { width: 350, height: 300 } },
      KEYBOARD_UP,
    );

    expect(placed.placement.startsWith("top")).toBe(true);
    expect(placed.y + 300).toBeLessThanOrEqual(keyboardTop - PADDING);
  });

  it("opens below the same caret when no keyboard covers the room there", async () => {
    const placed = await place(
      "bottom-start",
      { caret: caretAt(20, 300), menu: { width: 350, height: 300 } },
      NOTHING_RESERVED,
    );

    expect(placed.placement).toBe("bottom-start");
    expect(placed.y).toBe(300 + 20 + GAP);
  });

  it("caps a menu taller than the room left above the keyboard to that room", async () => {
    const placed = await place(
      "bottom-start",
      { caret: caretAt(20, 470), menu: { width: 350, height: 625 } },
      KEYBOARD_UP,
    );

    expect(placed.y).toBe(PADDING);
    expect(placed.maxHeight).toBe(`${keyboardTop - PADDING - PADDING}px`);
  });

  it("keeps an upward menu below a reserved top edge", async () => {
    const placed = await place(
      "bottom-start",
      { caret: caretAt(20, 470), menu: { width: 350, height: 625 } },
      { ...KEYBOARD_UP, topPx: 59 },
    );

    expect(placed.y).toBe(59 + PADDING);
    expect(placed.maxHeight).toBe(`${keyboardTop - PADDING - 59 - PADDING}px`);
  });
});

describe("initialComposerMenuPlacement", () => {
  function caretRect(y: number): DOMRect {
    return new DOMRect(20, y, 0, 20);
  }

  it("prefers above when the room below the caret is covered by the keyboard", () => {
    expect(
      initialComposerMenuPlacement(
        caretRect(300),
        VIEWPORT.height,
        KEYBOARD_UP,
      ),
    ).toBe("top-start");
  });

  it("prefers below for the same caret with no keyboard", () => {
    expect(
      initialComposerMenuPlacement(
        caretRect(300),
        VIEWPORT.height,
        NOTHING_RESERVED,
      ),
    ).toBe("bottom-start");
  });

  it("does not count a reserved top edge as room above", () => {
    // Neither side reaches the open-time estimate, so the side with more
    // usable room wins: 188px below against 270px (30 reserved) or 180px (120
    // reserved) above.
    expect(
      initialComposerMenuPlacement(caretRect(300), VIEWPORT.height, {
        ...KEYBOARD_UP,
        topPx: 30,
      }),
    ).toBe("top-start");
    expect(
      initialComposerMenuPlacement(caretRect(300), VIEWPORT.height, {
        ...KEYBOARD_UP,
        topPx: 120,
      }),
    ).toBe("bottom-start");
  });

  it("falls back to below with no caret rect yet", () => {
    expect(
      initialComposerMenuPlacement(null, VIEWPORT.height, KEYBOARD_UP),
    ).toBe("bottom-start");
  });
});

describe("composerMenuMiddleware in landscape", () => {
  // A landscape phone: the sensor housing's safe-area inset on each side.
  const LANDSCAPE: Rect = { x: 0, y: 0, width: 844, height: 390 };
  const SIDE_INSET = 59;
  const SIDES_RESERVED: ComposerMenuReservedEdges = {
    ...NOTHING_RESERVED,
    leftPx: SIDE_INSET,
    rightPx: SIDE_INSET,
  };

  async function placeLandscape(
    caretX: number,
    reserved: ComposerMenuReservedEdges,
  ): Promise<Placed> {
    const menu = document.createElement("div");
    const geometry: Geometry = {
      caret: caretAt(caretX, 60),
      menu: { width: 350, height: 200 },
    };
    const result = await computePosition(
      { getBoundingClientRect: () => new DOMRect() },
      menu,
      {
        placement: "bottom-start",
        middleware: composerMenuMiddleware(reserved),
        platform: {
          ...fakePlatform(geometry),
          getClippingRect: () => LANDSCAPE,
        },
      },
    );
    return {
      x: result.x,
      y: result.y,
      placement: result.placement,
      maxHeight: menu.style.maxHeight,
    };
  }

  it("keeps a menu opened near the right edge clear of the right inset", async () => {
    // Far enough right that neither alignment fits without the clamp.
    const { x } = await placeLandscape(830, SIDES_RESERVED);

    expect(x + 350).toBeLessThanOrEqual(LANDSCAPE.width - SIDE_INSET - PADDING);
  });

  it("keeps a menu opened at the left edge clear of the left inset", async () => {
    const { x } = await placeLandscape(0, SIDES_RESERVED);

    expect(x).toBe(SIDE_INSET + PADDING);
  });

  it("uses the plain padding at the sides when nothing is reserved", async () => {
    const { x } = await placeLandscape(0, NOTHING_RESERVED);

    expect(x).toBe(PADDING);
  });
});

describe("readComposerMenuReservedEdges", () => {
  const root = document.documentElement;

  function setInsets(insets: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  }): void {
    root.style.setProperty("--safe-area-inset-top", `${insets.top}px`);
    root.style.setProperty("--safe-area-inset-right", `${insets.right}px`);
    root.style.setProperty("--safe-area-inset-bottom", `${insets.bottom}px`);
    root.style.setProperty("--safe-area-inset-left", `${insets.left}px`);
    // The inset reader caches until a viewport event retires it.
    window.dispatchEvent(new Event("resize"));
  }

  afterEach(() => {
    for (const edge of ["top", "right", "bottom", "left"]) {
      root.style.removeProperty(`--safe-area-inset-${edge}`);
    }
    root.style.removeProperty("--keyboard-inset");
    window.dispatchEvent(new Event("resize"));
  });

  it("reserves nothing where no inset or keyboard is published", () => {
    expect(readComposerMenuReservedEdges()).toEqual(NOTHING_RESERVED);
  });

  it("reserves every safe-area edge with the keyboard closed", () => {
    setInsets({ top: 47, right: 59, bottom: 34, left: 59 });

    expect(readComposerMenuReservedEdges()).toEqual({
      topPx: 47,
      bottomPx: 34,
      leftPx: 59,
      rightPx: 59,
    });
  });

  it("reserves the keyboard, not the keyboard plus the home-indicator strip under it", () => {
    // The keyboard's reported height is its whole frame, which already covers
    // the bottom safe-area strip.
    setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
    root.style.setProperty("--keyboard-inset", `${KEYBOARD_PX}px`);

    expect(readComposerMenuReservedEdges().bottomPx).toBe(KEYBOARD_PX);
  });
});
