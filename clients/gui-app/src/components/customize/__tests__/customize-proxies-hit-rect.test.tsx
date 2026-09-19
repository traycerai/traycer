import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hit boxes the hook publishes must be exactly what the REAL proxy button
 * paints. Mounts the real `CustomizeOverlay` (real `useHotspotRects`, real
 * `CustomizeProxies` fed `measurements.hitRects`, real tooltip and dnd
 * providers) over a clipped hotspot and reads the rendered button's inline
 * `left`/`top`/`width`/`height`, so a proxy that re-applied its own
 * `Math.max(24, ...)` centring or a `min-w-6`/`min-h-6` floor - and so crossed
 * the clip edge again - fails here even while the hook's returned rect is
 * right.
 */
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Inset {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
const NO_INSET: Inset = { left: 0, top: 0, right: 0, bottom: 0 };

// jsdom does no layout: stub the reads the hook uses (same technique as
// `customize-overlay.test.tsx` / `use-hotspot-rects.test.ts`).
function stubRect(node: HTMLElement, rect: Box): void {
  node.getBoundingClientRect = () =>
    new DOMRect(rect.x, rect.y, rect.width, rect.height);
  node.getClientRects = () => {
    const measured = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  };
}

function clipper(rect: Box, inset: Inset): HTMLElement {
  const element = document.createElement("div");
  element.style.setProperty("overflow-x", "hidden");
  element.style.setProperty("overflow-y", "hidden");
  document.body.appendChild(element);
  stubRect(element, rect);
  const metrics: Record<string, number> = {
    clientLeft: inset.left,
    clientTop: inset.top,
    clientWidth: rect.width - inset.left - inset.right,
    clientHeight: rect.height - inset.top - inset.bottom,
  };
  for (const [name, value] of Object.entries(metrics))
    Object.defineProperty(element, name, { configurable: true, value });
  return element;
}

function nodeIn(parent: HTMLElement, rect: Box): HTMLElement {
  const node = document.createElement("div");
  parent.appendChild(node);
  stubRect(node, rect);
  return node;
}

function instanceFor(node: HTMLElement): HotspotInstance {
  return {
    key: "composer.mic@shell:-",
    settingId: "composer.mic",
    sceneId: "shell",
    tileId: null,
    node,
    ghost: false,
    condition: null,
  };
}

async function renderedProxy(
  instance: HotspotInstance,
): Promise<HTMLButtonElement> {
  useCustomizeStore.getState().register(instance);
  render(<CustomizeOverlay />);
  await waitFor(() =>
    expect(
      document.querySelector(`[data-customize-proxy="${instance.key}"]`),
    ).not.toBeNull(),
  );
  const proxy = document.querySelector<HTMLButtonElement>(
    `[data-customize-proxy="${instance.key}"]`,
  );
  if (proxy === null) throw new Error("proxy did not render");
  return proxy;
}

/** What the browser is told to paint, read from the button's inline style. */
function painted(proxy: HTMLButtonElement): Box {
  return {
    x: Number.parseFloat(proxy.style.left),
    y: Number.parseFloat(proxy.style.top),
    width: Number.parseFloat(proxy.style.width),
    height: Number.parseFloat(proxy.style.height),
  };
}

beforeEach(() => {
  useThemeLibraryStore.setState({ panelAnimations: false });
  useCustomizeStore.setState({
    session: {
      scene: "in-place",
      opener: { kind: "none" },
      startedAt: Date.now(),
    },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
});

afterEach(() => {
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
  cleanup();
  document.body.innerHTML = "";
});

describe("CustomizeProxies paints the hook's hit box exactly", () => {
  it("short clipped source: 30x16 visible becomes a 30x24 button inside the clip", async () => {
    const parent = clipper({ x: 0, y: 10, width: 100, height: 40 }, NO_INSET);
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(painted(proxy)).toEqual({ x: 70, y: 10, width: 30, height: 24 });
  });

  it("narrow clipped source (mirror): 16x30 visible becomes a 24x30 button inside the clip", async () => {
    const parent = clipper({ x: 10, y: 0, width: 40, height: 100 }, NO_INSET);
    const node = nodeIn(parent, { x: 10, y: 70, width: 16, height: 50 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(painted(proxy)).toEqual({ x: 10, y: 70, width: 24, height: 30 });
  });

  it("a clip under 24px is never exceeded: the button is exactly the clip's extent", async () => {
    const parent = clipper({ x: 0, y: 10, width: 100, height: 20 }, NO_INSET);
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(painted(proxy)).toEqual({ x: 70, y: 10, width: 30, height: 20 });
  });

  it("a 10px sliver is still reachable and paints a 24px button ending at the clip edge", async () => {
    const parent = clipper({ x: 0, y: 0, width: 100, height: 100 }, NO_INSET);
    const node = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(painted(proxy)).toEqual({ x: 76, y: 10, width: 24, height: 30 });
  });

  it("a small, wholly visible hotspot is centred into a 24x24 button", async () => {
    const parent = clipper({ x: 0, y: 0, width: 100, height: 100 }, NO_INSET);
    const node = nodeIn(parent, { x: 10, y: 10, width: 10, height: 12 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(painted(proxy)).toEqual({ x: 3, y: 4, width: 24, height: 24 });
  });

  it("the button carries no size floor of its own that could re-cross the clip edge", async () => {
    const parent = clipper({ x: 0, y: 10, width: 100, height: 20 }, NO_INSET);
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(proxy.className).not.toMatch(/\bmin-[hw]-6\b/);
  });
});
