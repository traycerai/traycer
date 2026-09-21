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
  // The viewport shares its row with the count control, so it is narrower
  // by the control's width exactly while the control is mounted.
  define("clientWidth", (el) => {
    if (el.dataset.testid !== "viewport") return 0;
    const control = el.parentElement?.querySelector(
      "[data-hidden-tabs-control]",
    );
    return geometry.outerWidth - (control ? geometry.controlWidth : 0);
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
  const { setScrollElement, hiddenTabKeys, revealTab } = useHiddenHeaderTabs(
    props.layout,
  );
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
      {hiddenTabKeys.length > 0 ? (
        <span data-hidden-tabs-control>{hiddenTabKeys.length}</span>
      ) : null}
      <output data-testid="hidden">{hiddenTabKeys.join(",")}</output>
      <button type="button" onClick={() => revealTab("b")}>
        reveal-b
      </button>
      <button type="button" onClick={() => revealTab("missing")}>
        reveal-missing
      </button>
    </div>
  );
}

function hidden(): string {
  return screen.getByTestId("hidden").textContent;
}

function overflowingGeometry(): Geometry {
  return {
    viewport: { left: 100, right: 500 },
    outerWidth: 440,
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
  it("counts tabs clipped on either edge, in DOM order, and not the fully visible ones", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("a,d");
  });

  it("tolerates one pixel of sub-pixel clipping", () => {
    geometry.tabs.d = { left: 420, right: 501 };
    geometry.tabs.a = { left: 99, right: 160 };
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("");
  });

  it("reports nothing when the content fits", () => {
    geometry.scrollWidth = 400;
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("");
  });

  it("recounts when the strip scrolls", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.tabs = {
      a: { left: -20, right: 100 },
      b: { left: 100, right: 240 },
      c: { left: 240, right: 360 },
      d: { left: 360, right: 460 },
    };
    fireEvent.scroll(screen.getByTestId("viewport"));
    expect(hidden()).toBe("a");
  });

  it("recounts when the viewport is resized", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.viewport = { left: 100, right: 700 };
    geometry.outerWidth = 640;
    geometry.scrollWidth = 700;
    fireResize();
    expect(hidden()).toBe("a");
  });

  it("clears the count once a resize makes everything fit", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.scrollWidth = 400;
    fireResize();
    expect(hidden()).toBe("");
  });

  it("counts a tab that is added past the edge", async () => {
    const { rerender } = render(<Harness layout="scroll" keys={["a", "b"]} />);
    expect(hidden()).toBe("a");
    geometry.tabs.e = { left: 520, right: 620 };
    // The DOM change is observed through a MutationObserver callback.
    await act(async () => {
      rerender(<Harness layout="scroll" keys={["a", "b", "e"]} />);
      await Promise.resolve();
    });
    expect(hidden()).toBe("a,e");
  });

  it("drops a removed tab, e.g. a collapsed group, from the count", async () => {
    const { rerender } = render(
      <Harness layout="scroll" keys={["a", "b", "c", "d"]} />,
    );
    await act(async () => {
      rerender(<Harness layout="scroll" keys={["b", "c"]} />);
      await Promise.resolve();
    });
    expect(hidden()).toBe("");
  });

  it("ignores tabs with no rendered width", () => {
    geometry.tabs.d = { left: 0, right: 0 };
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("a");
  });

  it("counts in shrink layout too when even compact tabs overflow", () => {
    render(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("a,d");
  });

  it("shows no count in shrink layout when the tabs fit", () => {
    geometry.scrollWidth = 400;
    render(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).toBe("");
  });

  it("recomputes from the new geometry when the layout switches", () => {
    const { rerender } = render(
      <Harness layout="scroll" keys={["a", "b", "c", "d"]} />,
    );
    expect(hidden()).toBe("a,d");
    geometry.scrollWidth = 400;
    rerender(<Harness layout="shrink" keys={["a", "b", "c", "d"]} />);
    fireResize();
    expect(hidden()).toBe("");
  });

  it("subtracts the count control's footprint so it cannot keep itself visible", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    expect(hidden()).not.toBe("");
    // Control mounted: clientWidth is 400. 430 content overflows that but fits
    // the 440px that exist once the control is gone, so the count must clear
    // and stay cleared after clientWidth grows back to 440.
    geometry.scrollWidth = 430;
    fireResize();
    expect(hidden()).toBe("");
    fireResize();
    expect(hidden()).toBe("");
  });

  it("still counts when content overflows even after the control's footprint is added back", () => {
    render(<Harness layout="scroll" keys={["a", "b", "c", "d"]} />);
    geometry.scrollWidth = 450;
    fireResize();
    expect(hidden()).toBe("a,d");
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

    it("does not reveal a hidden active tab when the count control narrows the viewport", () => {
      geometry.scrollWidth = 400;
      const scroll = renderWithActive("a", "scroll");
      expect(hidden()).toBe("");
      geometry.scrollWidth = 600;
      fireResize();
      expect(hidden()).toBe("a,d");
      // The control is now mounted and the viewport narrower; the observer
      // reports that too.
      fireResize();
      expect(hidden()).toBe("a,d");
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
});
