import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { useHiddenHeaderTabs } from "@/components/layout/tabs/use-hidden-header-tabs";
import type { TaskTabLayout } from "@/stores/settings/settings-store";

interface Box {
  readonly left: number;
  readonly right: number;
}

interface Geometry {
  viewport: Box;
  outerWidth: number;
  scrollWidth: number;
  controlWidth: number;
  tabs: Record<string, Box>;
}

let geometry: Geometry;
let activeKey: string | null = null;
let resizeCallbacks: Array<() => void> = [];

class ControllableResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }
  // Like the real observer, deliver an initial notification once a target is
  // observed; the hook relies on it for its first measurement.
  observe(): void {
    this.callback();
  }
  unobserve(): void {}
  disconnect(): void {}
}

function rect(box: Box): DOMRect {
  return {
    left: box.left,
    right: box.right,
    x: box.left,
    y: 0,
    top: 0,
    bottom: 20,
    width: box.right - box.left,
    height: 20,
    toJSON: () => ({}),
  };
}

function installGeometry(): void {
  const define = (name: string, getter: (el: HTMLElement) => unknown) =>
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return getter(this);
      },
    });
  // The viewport shares its row with the two edge slots, so it is narrower
  // by one slot width per slot mounted (400 with both slots, 480 with none).
  define("clientWidth", (el) => {
    if (el.dataset.testid !== "viewport") return 0;
    const controls =
      el.parentElement?.querySelectorAll("[data-hidden-tabs-control]").length ??
      0;
    return geometry.outerWidth - controls * geometry.controlWidth;
  });
  define("scrollWidth", (el) =>
    el.dataset.testid === "viewport" ? geometry.scrollWidth : 0,
  );
  define("offsetWidth", (el) =>
    el.hasAttribute("data-hidden-tabs-control") ? geometry.controlWidth : 0,
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.dataset.testid === "viewport") return rect(geometry.viewport);
      const key = this.dataset.headerTabKey;
      const box = key === undefined ? undefined : geometry.tabs[key];
      return rect(box ?? { left: 0, right: 0 });
    },
  });
}

function uninstallGeometry(): void {
  for (const name of [
    "clientWidth",
    "scrollWidth",
    "offsetWidth",
    "getBoundingClientRect",
  ]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
}

function Harness(props: {
  readonly layout: TaskTabLayout;
  readonly keys: ReadonlyArray<string>;
}) {
  const { setScrollElement, hiddenTabKeys, hasOverflow, revealTab } =
    useHiddenHeaderTabs(props.layout);
  return (
    <div>
      <div ref={setScrollElement} data-testid="viewport">
        {props.keys.map((key) => (
          <button
            key={key}
            type="button"
            data-header-tab-key={key}
            role="tab"
            aria-selected={key === activeKey}
          >
            {key}
          </button>
        ))}
      </div>
      {hasOverflow ? (
        <>
          <span data-hidden-tabs-control="left" />
          <span data-hidden-tabs-control="right" />
        </>
      ) : null}
      <output data-testid="hidden">
        {hiddenTabKeys.left.join(",")}|{hiddenTabKeys.right.join(",")}
      </output>
      <output data-testid="overflow">{String(hasOverflow)}</output>
      <button type="button" onClick={() => revealTab("b")}>
        reveal-b
      </button>
      <button type="button" onClick={() => revealTab("missing")}>
        reveal-missing
      </button>
    </div>
  );
}

// "left|right" membership of the two edge menus.
function hidden(): string {
  return screen.getByTestId("hidden").textContent;
}

function overflow(): string {
  return screen.getByTestId("overflow").textContent;
}

function controlCount(): number {
  return document.querySelectorAll("[data-hidden-tabs-control]").length;
}

function overflowingGeometry(): Geometry {
  return {
    viewport: { left: 100, right: 500 },
    outerWidth: 480,
    scrollWidth: 600,
    controlWidth: 40,
    tabs: {
      a: { left: 60, right: 160 },
      b: { left: 160, right: 300 },
      c: { left: 300, right: 420 },
      d: { left: 420, right: 520 },
    },
  };
}

function fireResize(): void {
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
}

beforeEach(() => {
  resizeCallbacks = [];
  activeKey = null;
  geometry = overflowingGeometry();
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  installGeometry();
});

afterEach(() => {
  cleanup();
  uninstallGeometry();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useHiddenHeaderTabs", () => {
  it("lists tabs clipped on either edge, in DOM order, and not the fully visible ones", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("a|d");
  });

  it("tolerates one pixel of sub-pixel clipping", () => {
    geometry.tabs.d = { left: 420, right: 501 };
    geometry.tabs.a = { left: 99, right: 160 };
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("|");
  });

  it("reports nothing when the content fits", () => {
    geometry.scrollWidth = 400;
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("|");
  });

  it("re-measures when the strip scrolls", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.tabs = {
      a: { left: -20, right: 100 },
      b: { left: 100, right: 240 },
      c: { left: 240, right: 360 },
      d: { left: 360, right: 460 },
    };
    fireEvent.scroll(screen.getByTestId("viewport"));
    expect(hidden()).toBe("a|");
  });

  it("re-measures when the viewport is resized", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.viewport = { left: 100, right: 700 };
    geometry.outerWidth = 640;
    geometry.scrollWidth = 700;
    fireResize();
    expect(hidden()).toBe("a|");
  });

  it("clears the hidden membership once a resize makes everything fit", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.scrollWidth = 400;
    fireResize();
    expect(hidden()).toBe("|");
  });

  it("lists a tab that is added past the edge", async () => {
    const { rerender } = render(<Harness layout="scroll" keys={["a", "b"]} />);
    expect(hidden()).toBe("a|");
    geometry.tabs.e = { left: 520, right: 620 };
    // The DOM change is observed through a MutationObserver callback.
    await act(async () => {
      rerender(<Harness layout="scroll" keys={["a", "b", "e"]} />);
      await Promise.resolve();
    });
    expect(hidden()).toBe("a|e");
  });

  it("drops a removed tab, e.g. a collapsed group, from the membership", async () => {
    const { rerender } = render(
      <Harness layout="scroll" keys={["a", "b", "c", "d"]} />,
    );
    await act(async () => {
      rerender(<Harness layout="scroll" keys={["b", "c"]} />);
      await Promise.resolve();
    });
    expect(hidden()).toBe("|");
  });

  it("ignores tabs with no rendered width", () => {
    geometry.tabs.d = { left: 0, right: 0 };
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("a|");
  });

  it("lists hidden tabs in shrink layout too when even compact tabs overflow", () => {
    render(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("a|d");
  });

  it("lists no hidden tabs in shrink layout when the tabs fit", () => {
    geometry.scrollWidth = 400;
    render(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("|");
  });

  it("recomputes from the new geometry when the layout switches", () => {
    const { rerender } = render(
      <Harness layout="scroll" keys={["a", "b", "c", "d"]} />,
    );
    expect(hidden()).toBe("a|d");
    geometry.scrollWidth = 400;
    rerender(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    fireResize();
    expect(hidden()).toBe("|");
  });

  it("subtracts both edge slots' footprint so they cannot keep themselves mounted", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).not.toBe("|");
    // Slots mounted: clientWidth is 400. 470 content overflows that but fits
    // the 480px that exist once both slots are gone, so the slots must clear
    // and stay cleared after clientWidth grows back to 480.
    geometry.scrollWidth = 470;
    fireResize();
    expect(hidden()).toBe("|");
    fireResize();
    expect(hidden()).toBe("|");
  });

  it("still reports overflow when content exceeds the width even after both slots' footprint is added back", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.scrollWidth = 490;
    fireResize();
    expect(hidden()).toBe("a|d");
  });

  describe("per-side edge menus", () => {
    const KEYS = ["a", "b", "c", "d"];

    it("mounts both control slots whenever the strip overflows, even if one side is empty", () => {
      geometry.tabs.a = { left: 100, right: 160 };
      render(<Harness layout="scroll" keys={KEYS} />);
      expect(hidden()).toBe("|d");
      expect(overflow()).toBe("true");
      expect(controlCount()).toBe(2);
    });

    it("moves tabs between sides only as the strip scrolls", () => {
      render(<Harness layout="scroll" keys={KEYS} />);
      expect(hidden()).toBe("a|d");
      geometry.tabs = {
        a: { left: -60, right: 40 },
        b: { left: 40, right: 180 },
        c: { left: 180, right: 300 },
        d: { left: 300, right: 400 },
      };
      fireEvent.scroll(screen.getByTestId("viewport"));
      expect(hidden()).toBe("a,b|");
      geometry.tabs = {
        a: { left: 100, right: 200 },
        b: { left: 200, right: 340 },
        c: { left: 340, right: 460 },
        d: { left: 460, right: 560 },
      };
      fireEvent.scroll(screen.getByTestId("viewport"));
      expect(hidden()).toBe("|d");
    });

    it("lists a tab wider than the viewport on both sides", () => {
      geometry.tabs = {
        a: { left: 60, right: 160 },
        b: { left: 50, right: 600 },
        c: { left: 600, right: 700 },
        d: { left: 700, right: 800 },
      };
      render(<Harness layout="scroll" keys={KEYS} />);
      expect(hidden()).toBe("a,b|b,c,d");
    });

    it("keeps DOM order within each side", () => {
      geometry.tabs = {
        a: { left: 0, right: 50 },
        b: { left: 50, right: 99 },
        c: { left: 99, right: 400 },
        d: { left: 500, right: 560 },
      };
      render(<Harness layout="scroll" keys={["d", "c", "b", "a"]} />);
      expect(hidden()).toBe("b,a|d");
    });

    it("does not let the two-slot footprint sustain overflow after a resize", () => {
      render(<Harness layout="scroll" keys={KEYS} />);
      expect(controlCount()).toBe(2);
      // 470 fits the 480px that exist once both slots are gone.
      geometry.scrollWidth = 470;
      fireResize();
      expect(overflow()).toBe("false");
      expect(controlCount()).toBe(0);
      fireResize();
      expect(overflow()).toBe("false");
      expect(hidden()).toBe("|");
    });

    it("keeps overflow when content exceeds the width with both slots added back", () => {
      render(<Harness layout="scroll" keys={KEYS} />);
      geometry.scrollWidth = 490;
      fireResize();
      expect(overflow()).toBe("true");
      expect(controlCount()).toBe(2);
    });

    it("reports no overflow and no slots when everything fits", () => {
      geometry.scrollWidth = 400;
      render(<Harness layout="scroll" keys={KEYS} />);
      expect(overflow()).toBe("false");
      expect(controlCount()).toBe(0);
    });
  });

  it("reveal scrolls the tab into view and focuses it", () => {
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    fireEvent.click(screen.getByText("reveal-b"));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scroll.mock.contexts[0]).toBe(screen.getByText("b"));
    expect(document.activeElement).toBe(screen.getByText("b"));
  });

  it("reveal of an unknown key is a no-op", () => {
    const scroll = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    render(<Harness layout="scroll" keys={["a", "b"]} />);
    fireEvent.click(screen.getByText("reveal-missing"));
    expect(scroll).not.toHaveBeenCalled();
  });

  describe("active tab re-reveal", () => {
    const KEYS = ["a", "b", "c", "d"];

    function renderWithActive(
      active: string,
      layout: TaskTabLayout,
    ): MockInstance<Element["scrollIntoView"]> {
      activeKey = active;
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      render(<Harness layout={layout} keys={KEYS} />);
      // Mount itself reveals the active tab; only later calls are under test.
      scroll.mockClear();
      return scroll;
    }

    it("does not snap back when a manual scroll makes the active tab visible", () => {
      const scroll = renderWithActive("a", "scroll");
      geometry.tabs.a = { left: 100, right: 200 };
      fireEvent.scroll(screen.getByTestId("viewport"));
      expect(scroll).not.toHaveBeenCalled();
    });

    it("does not snap back when a manual scroll hides the active tab", () => {
      const scroll = renderWithActive("b", "scroll");
      geometry.tabs.b = { left: 60, right: 190 };
      fireEvent.scroll(screen.getByTestId("viewport"));
      expect(scroll).not.toHaveBeenCalled();
      expect(hidden()).toContain("b");
    });

    it("does not reveal a hidden active tab when the edge slots narrow the viewport", () => {
      geometry.scrollWidth = 400;
      const scroll = renderWithActive("a", "scroll");
      expect(hidden()).toBe("|");
      geometry.scrollWidth = 600;
      fireResize();
      expect(hidden()).toBe("a|d");
      // Both slots are now mounted and the viewport narrower; the observer
      // reports that too.
      fireResize();
      expect(hidden()).toBe("a|d");
      expect(scroll).not.toHaveBeenCalled();
    });

    it("reveals the active tab when the viewport shrinks while it was visible", () => {
      geometry.scrollWidth = 400;
      const scroll = renderWithActive("b", "scroll");
      geometry.outerWidth = 300;
      fireResize();
      expect(scroll).toHaveBeenCalled();
      for (const context of scroll.mock.contexts) {
        expect(context).toBe(screen.getByText("b"));
      }
    });

    it("tracks an aria-selected-only change, so a later shrink reveals the new active tab", async () => {
      geometry.scrollWidth = 400;
      activeKey = "b";
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      const { rerender } = render(<Harness layout="scroll" keys={KEYS} />);
      // Both tabs stay visible and no child is added or removed: only the
      // selection attribute moves, which the hook must observe by itself.
      activeKey = "c";
      await act(async () => {
        rerender(<Harness layout="scroll" keys={KEYS} />);
        await Promise.resolve();
      });
      scroll.mockClear();
      geometry.outerWidth = 300;
      fireResize();
      expect(scroll).toHaveBeenCalled();
      for (const context of scroll.mock.contexts) {
        expect(context).toBe(screen.getByText("c"));
      }
    });
  });

  describe("reordering frames with a translate transform", () => {
    const TRANSLATE_72 = "matrix(1, 0, 0, 1, 72, 0)";
    const TRANSLATE_MINUS_72 = "matrix(1, 0, 0, 1, -72, 0)";
    const TRANSLATE_72_3D =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 72, 0, 0, 1)";
    const TRANSLATE_MINUS_72_3D =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -72, 0, 0, 1)";

    interface Frame {
      readonly id: string;
      readonly keys: ReadonlyArray<string>;
      readonly transform: string;
    }

    function FrameHarness(props: { readonly frames: ReadonlyArray<Frame> }) {
      const { setScrollElement, hiddenTabKeys, hasOverflow } =
        useHiddenHeaderTabs("scroll");
      return (
        <div>
          <div ref={setScrollElement} data-testid="viewport">
            {props.frames.map((frame) => (
              <div
                key={frame.id}
                data-strip-item-id={frame.id}
                style={{ transform: frame.transform }}
              >
                {frame.keys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    data-header-tab-key={key}
                    aria-selected={key === activeKey}
                  >
                    {key}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {hasOverflow ? (
            <>
              <span data-hidden-tabs-control="left" />
              <span data-hidden-tabs-control="right" />
            </>
          ) : null}
          <output data-testid="hidden">
            {hiddenTabKeys.left.join(",")}|{hiddenTabKeys.right.join(",")}
          </output>
        </div>
      );
    }

    // Viewport 0..444, three 192px tabs. Initially A,B,C sit untransformed
    // (A 0..192, B 192..384, C 384..576, so only C is clipped). After the
    // reorder to A,C,B the final layout is A 0..192, C 192..384, B 384..576
    // (only B is clipped), while mid-flip the rendered rects are shifted by
    // the frames' transforms: C 264..456 (+72), B 312..504 (-72).
    function initialGeometry(): void {
      geometry.viewport = { left: 0, right: 444 };
      geometry.outerWidth = 444;
      geometry.scrollWidth = 576;
      geometry.tabs = {
        a: { left: 0, right: 192 },
        b: { left: 192, right: 384 },
        c: { left: 384, right: 576 },
      };
    }

    function midFlipGeometry(): void {
      geometry.tabs = {
        a: { left: 0, right: 192 },
        c: { left: 264, right: 456 },
        b: { left: 312, right: 504 },
      };
    }

    function settleGeometry(): void {
      geometry.tabs = {
        a: { left: 0, right: 192 },
        c: { left: 192, right: 384 },
        b: { left: 384, right: 576 },
      };
    }

    const ABC: ReadonlyArray<Frame> = [
      { id: "a", keys: ["a"], transform: "none" },
      { id: "b", keys: ["b"], transform: "none" },
      { id: "c", keys: ["c"], transform: "none" },
    ];

    function reorderedFrames(
      cTransform: string,
      bTransform: string,
    ): ReadonlyArray<Frame> {
      return [
        { id: "a", keys: ["a"], transform: "none" },
        { id: "c", keys: ["c"], transform: cTransform },
        { id: "b", keys: ["b"], transform: bTransform },
      ];
    }

    it.each([
      { name: "2D", c: TRANSLATE_72, b: TRANSLATE_MINUS_72 },
      { name: "3D", c: TRANSLATE_72_3D, b: TRANSLATE_MINUS_72_3D },
    ])(
      "hides only the tab clipped in its final layout, mid-flip and after it settles ($name matrix)",
      async ({ c, b }) => {
        initialGeometry();
        const { rerender } = render(<FrameHarness frames={ABC} />);
        expect(hidden()).toBe("|c");

        midFlipGeometry();
        await act(async () => {
          rerender(<FrameHarness frames={reorderedFrames(c, b)} />);
          await Promise.resolve();
        });
        expect(hidden()).toBe("|b");

        // Only the transforms settle: same children, no resize, scroll or
        // selection change.
        settleGeometry();
        await act(async () => {
          rerender(<FrameHarness frames={reorderedFrames("none", "none")} />);
          await Promise.resolve();
        });
        expect(hidden()).toBe("|b");
      },
    );

    it("keeps member offsets when split members share one translated frame", () => {
      geometry.viewport = { left: 0, right: 444 };
      geometry.outerWidth = 444;
      geometry.scrollWidth = 576;
      // Frame translated +72: members rendered 264..456 and 456..648, final
      // 192..384 and 384..576.
      geometry.tabs = {
        x: { left: 264, right: 456 },
        y: { left: 456, right: 648 },
      };
      render(
        <FrameHarness
          frames={[{ id: "split", keys: ["x", "y"], transform: TRANSLATE_72 }]}
        />,
      );
      expect(hidden()).toBe("|y");
    });

    it("keeps tabs without a frame working", () => {
      // The plain harness renders bare buttons with no [data-strip-item-id].
      render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
      expect(hidden()).toBe("a|d");
    });

    it("snapshots active visibility by its final position, so a later shrink reveals it", async () => {
      initialGeometry();
      midFlipGeometry();
      activeKey = "c";
      const scroll = vi
        .spyOn(Element.prototype, "scrollIntoView")
        .mockImplementation(() => undefined);
      render(
        <FrameHarness
          frames={reorderedFrames(TRANSLATE_72, TRANSLATE_MINUS_72)}
        />,
      );
      // Rendered 264..456 looks clipped, but C's final 192..384 is visible.
      await act(async () => {
        await Promise.resolve();
      });
      scroll.mockClear();
      geometry.outerWidth = 360;
      fireResize();
      expect(scroll).toHaveBeenCalled();
      for (const context of scroll.mock.contexts) {
        expect(context).toBe(screen.getByText("c"));
      }
    });
  });
});
