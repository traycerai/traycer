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

function instanceWith(
  settingId: "composer.mic" | "tabs.home",
  node: HTMLElement,
): HotspotInstance {
  return {
    key: `${settingId}@shell:-`,
    settingId,
    sceneId: "shell",
    tileId: null,
    node,
    ghost: false,
    condition: null,
  };
}

const instanceFor = (node: HTMLElement): HotspotInstance =>
  instanceWith("composer.mic", node);

function proxyOf(instance: HotspotInstance): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-customize-proxy="${instance.key}"]`,
  );
}

/** Every proxy button, i.e. the whole keyboard (roving tab stop) group. */
function proxyKeys(): string[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>("[data-customize-proxy]"),
  ].map((button) => button.getAttribute("data-customize-proxy") ?? "");
}

/** Renders the overlay over `instance` and proves no proxy is drawn for it. */
async function expectNoProxy(instance: HotspotInstance): Promise<void> {
  useCustomizeStore.getState().register(instance);
  render(<CustomizeOverlay />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(proxyOf(instance)).toBeNull();
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

  it("a clip under 24px tall draws no button at all", async () => {
    const parent = clipper({ x: 0, y: 10, width: 100, height: 20 }, NO_INSET);
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    await expectNoProxy(instanceFor(node));
  });

  it("a clip under 24px wide draws no button at all (mirror)", async () => {
    const parent = clipper({ x: 10, y: 0, width: 20, height: 100 }, NO_INSET);
    const node = nodeIn(parent, { x: 10, y: 70, width: 16, height: 50 });

    await expectNoProxy(instanceFor(node));
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
    const parent = clipper({ x: 0, y: 10, width: 100, height: 40 }, NO_INSET);
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    const proxy = await renderedProxy(instanceFor(node));

    expect(proxy.className).not.toMatch(/\bmin-[hw]-6\b/);
  });
});

// Two hotspots side by side in one clip: A is whole (50..86), B is a 10px
// sliver (90..130 clipped to 90..100) whose 24px target (76..100) would land
// on A. A wins on visible fraction; B gets no proxy - not in the DOM, not the
// keyboard tab stop, and a popover left open on it closes.
describe("CustomizeProxies never paints a clipped sliver over an accepted neighbour", () => {
  function pair() {
    const parent = clipper({ x: 0, y: 0, width: 100, height: 100 }, NO_INSET);
    // B is created first: a pass that fell back to document order would
    // wrongly favour it.
    const bNode = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
    const aNode = nodeIn(parent, { x: 50, y: 10, width: 36, height: 30 });
    return {
      a: instanceWith("composer.mic", aNode),
      b: instanceWith("tabs.home", bNode),
    };
  }

  it.each([
    ["A registered first", ["a", "b"]],
    ["B registered first", ["b", "a"]],
  ] as const)(
    "the whole neighbour keeps its exact box and the sliver is absent from the proxy group (%s)",
    async (_name, order) => {
      const { a, b } = pair();
      const by = { a, b };
      for (const key of order) useCustomizeStore.getState().register(by[key]);

      render(<CustomizeOverlay />);
      await waitFor(() => expect(proxyOf(a)).not.toBeNull());

      const proxy = proxyOf(a);
      if (proxy === null) throw new Error("A did not render");
      expect(painted(proxy)).toEqual({ x: 50, y: 10, width: 36, height: 30 });
      expect(proxyOf(b)).toBeNull();
      // The whole keyboard group is A alone, and A holds its only tab stop.
      expect(proxyKeys()).toEqual([a.key]);
      expect(proxy.tabIndex).toBe(0);
    },
  );

  it("equally clipped identical hotspots go by document order, not registration order", async () => {
    const parent = clipper({ x: 0, y: 0, width: 100, height: 100 }, NO_INSET);
    const first = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
    const second = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
    const p = instanceWith("composer.mic", first);
    const q = instanceWith("tabs.home", second);
    useCustomizeStore.getState().register(q);
    useCustomizeStore.getState().register(p);

    render(<CustomizeOverlay />);
    await waitFor(() => expect(proxyOf(p)).not.toBeNull());

    const proxy = proxyOf(p);
    if (proxy === null) throw new Error("P did not render");
    expect(painted(proxy)).toEqual({ x: 76, y: 10, width: 24, height: 30 });
    expect(proxyOf(q)).toBeNull();
    expect(proxyKeys()).toEqual([p.key]);
  });

  it("a popover already open on the rejected sliver closes and is announced", async () => {
    const { a, b } = pair();
    useCustomizeStore.getState().register(b);
    useCustomizeStore.getState().register(a);
    useCustomizeStore.setState({ popoverKey: b.key, activeKey: b.key });

    render(<CustomizeOverlay />);

    await waitFor(() =>
      expect(useCustomizeStore.getState().popoverKey).toBeNull(),
    );
    expect(useCustomizeStore.getState().activeKey).toBe(a.key);
    expect(useCustomizeStore.getState().announcement).toMatch(
      /no longer on screen/,
    );
    expect(proxyOf(b)).toBeNull();
    expect(proxyOf(a)).not.toBeNull();
  });
});
