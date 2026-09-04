import { act, cleanup, render } from "@testing-library/react";
import type { ToasterProps } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { Toaster } from "@/components/ui/sonner";
import type { TileRect } from "@/lib/browser-view/tiles/tile-rect-registry";
import { registerTileRect } from "@/lib/browser-view/tiles/tile-rect-registry";

// Ticket 06: the toaster picks the least-overlapping of sonner's six fixed
// anchors against live registered tile rects, and freezes that choice while
// a toast is visible. `sonner`'s real `Toaster` only mounts an
// `<ol data-sonner-toaster>` while a toast exists (see sonner.tsx's
// selector comment) - this stub reproduces exactly that, with a real
// `getBoundingClientRect`, so the wrapper's own visibility/measurement
// logic runs unmodified against real DOM nodes.
type SonnerToasterSpy = (props: ToasterProps) => void;

const sonnerToasterProps = vi.hoisted(() => vi.fn<SonnerToasterSpy>());
const stubToasterList = vi.hoisted<{
  visible: boolean;
  size: { width: number; height: number };
}>(() => ({
  visible: false,
  size: { width: 356, height: 120 },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("sonner", () => ({
  Toaster: (
    props: ToasterProps & { readonly ref?: React.Ref<HTMLElement> },
  ) => {
    sonnerToasterProps(props);
    return (
      <section ref={props.ref}>
        {stubToasterList.visible ? (
          <ol
            data-sonner-toaster=""
            ref={(element: HTMLOListElement | null) => {
              if (element === null) return;
              const { width, height } = stubToasterList.size;
              Object.defineProperty(element, "getBoundingClientRect", {
                configurable: true,
                value: () => ({
                  left: 0,
                  top: 0,
                  right: width,
                  bottom: height,
                  width,
                  height,
                  x: 0,
                  y: 0,
                  toJSON: () => ({}),
                }),
              });
            }}
          />
        ) : null}
      </section>
    );
  },
}));

function lastSonnerToasterProps(): ToasterProps {
  const lastCall = sonnerToasterProps.mock.lastCall;
  if (lastCall === undefined) {
    throw new Error("Expected Sonner Toaster to be rendered.");
  }
  const [props] = lastCall;
  return props;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function makeTileKey(id: string): BrowserViewTileKey {
  return {
    viewTabId: "view-1",
    paneId: "pane-1",
    tileInstanceId: id,
    pageSessionId: "page-1",
  };
}

// Rects for each of sonner's six anchors, matching the jsdom default
// 1200x800 viewport, the stub's 356x120 toaster size, and the wrapper's
// 24px edge offset (sonner's own unoverridden `VIEWPORT_OFFSET` default).
const TOP_LEFT_RECT: TileRect = {
  left: 24,
  top: 24,
  right: 380,
  bottom: 144,
  width: 356,
  height: 120,
};
const TOP_CENTER_RECT: TileRect = {
  left: 422,
  top: 24,
  right: 778,
  bottom: 144,
  width: 356,
  height: 120,
};
const TOP_RIGHT_RECT: TileRect = {
  left: 820,
  top: 24,
  right: 1176,
  bottom: 144,
  width: 356,
  height: 120,
};
const BOTTOM_LEFT_RECT: TileRect = {
  left: 24,
  top: 656,
  right: 380,
  bottom: 776,
  width: 356,
  height: 120,
};
const BOTTOM_CENTER_RECT: TileRect = {
  left: 422,
  top: 656,
  right: 778,
  bottom: 776,
  width: 356,
  height: 120,
};
const BOTTOM_RIGHT_RECT: TileRect = {
  left: 820,
  top: 656,
  right: 1176,
  bottom: 776,
  width: 356,
  height: 120,
};

let pendingDeregisters: Array<() => void> = [];

function registerTile(id: string, rect: TileRect): void {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({
    ...rect,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
  pendingDeregisters.push(registerTileRect(makeTileKey(id), element));
}

describe("<Toaster /> toast placement", () => {
  beforeEach(() => {
    sonnerToasterProps.mockClear();
    stubToasterList.visible = false;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
  });

  afterEach(() => {
    pendingDeregisters.forEach((deregister) => deregister());
    pendingDeregisters = [];
    cleanup();
  });

  it("uses the default anchor when no tiles are registered", () => {
    render(<Toaster />);

    expect(lastSonnerToasterProps().position).toBe("bottom-right");
  });

  it("moves off the default anchor when a tile covers it", async () => {
    const { rerender } = render(<Toaster />);
    await primeMeasurement(rerender);

    await act(async () => {
      registerTile("covers-default", BOTTOM_RIGHT_RECT);
      await flush();
    });

    expect(lastSonnerToasterProps().position).not.toBe("bottom-right");
  });

  it("keeps the default anchor when every anchor is covered", async () => {
    const { rerender } = render(<Toaster />);
    await primeMeasurement(rerender);

    await act(async () => {
      registerTile("top-left", TOP_LEFT_RECT);
      registerTile("top-center", TOP_CENTER_RECT);
      registerTile("top-right", TOP_RIGHT_RECT);
      registerTile("bottom-left", BOTTOM_LEFT_RECT);
      registerTile("bottom-center", BOTTOM_CENTER_RECT);
      registerTile("bottom-right", BOTTOM_RIGHT_RECT);
      await flush();
    });

    expect(lastSonnerToasterProps().position).toBe("bottom-right");
  });

  it("does not re-anchor while a toast is visible", async () => {
    const { rerender } = render(<Toaster />);
    await primeMeasurement(rerender);

    stubToasterList.visible = true;
    await act(async () => {
      rerender(<Toaster />);
      await flush();
    });

    expect(lastSonnerToasterProps().position).toBe("bottom-right");

    await act(async () => {
      registerTile("covers-default", BOTTOM_RIGHT_RECT);
      await flush();
    });

    // A tile now covers the anchor the visible toast is already using, but
    // invariant 10 only reduces future overlap - it never moves a toaster
    // out from under an already-showing toast.
    expect(lastSonnerToasterProps().position).toBe("bottom-right");
  });
});

/** Shows and hides the stubbed toast list once so the wrapper measures a
 * real toaster rect before a test starts registering tiles - without this,
 * `pickToasterAnchor` has no size to compare tile rects against and always
 * keeps the default. */
async function primeMeasurement(
  rerender: (ui: React.ReactElement) => void,
): Promise<void> {
  stubToasterList.visible = true;
  await act(async () => {
    rerender(<Toaster />);
    await flush();
  });
  stubToasterList.visible = false;
  await act(async () => {
    rerender(<Toaster />);
    await flush();
  });
}
