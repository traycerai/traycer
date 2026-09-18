import {
  registerCustomizeOptions,
  type CustomizeControl,
  type CustomizeOptions,
} from "@/lib/customize/customize-options";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { getCustomizeSetting } from "@/lib/customize/catalog";
import type { HotspotInstance } from "@/stores/customize/customize-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

// jsdom does no layout, so a plain node measures as an all-zero rect and the
// REAL `useHotspotRects` would (correctly) call it unreachable. Stub the two
// DOM reads the hook uses instead of faking layout or mocking the hook -
// `useHotspotRects` itself stays real for this suite.
function stubRect(
  node: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  node.getBoundingClientRect = () =>
    new DOMRect(rect.x, rect.y, rect.width, rect.height);
  node.getClientRects = () => {
    const measured = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  };
}

function fixtureNode(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): HTMLElement {
  const node = document.createElement("div");
  document.body.appendChild(node);
  stubRect(node, rect);
  return node;
}

function instance(
  settingId: HotspotInstance["settingId"],
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

// A controllable stand-in for jsdom's missing `ResizeObserver`, so a resize
// can be driven deterministically. Only installed in the one test that needs
// it (see below) - every other test runs against the globally stubbed no-op
// `MockResizeObserver` from the shared test setup, since the hook's initial
// measurement runs synchronously on mount regardless of the observer.
class ControllableResizeObserver implements ResizeObserver {
  static instances: ControllableResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllableResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(): void {
    this.callback([], this);
  }
}

function proxyFor(key: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-customize-proxy="${key}"]`,
  );
}

function resetStores(): void {
  // No animation to wait out: the overlay's own entry/exit transition reads
  // this, and forcing it off keeps assertions synchronous instead of racing
  // a real-timer fade.
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
}

beforeEach(resetStores);
afterEach(() => {
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
  cleanup();
  document
    .querySelectorAll("[data-customize-inert]")
    .forEach((node) => node.remove());
  document.body.innerHTML = "";
});

describe("CustomizeOverlay", () => {
  it("draws a proxy for each registered, selected instance, measured through the real hook", () => {
    const a = instance(
      "composer.mic",
      fixtureNode({ x: 0, y: 0, width: 24, height: 24 }),
    );
    const b = instance(
      "tabs.home",
      fixtureNode({ x: 100, y: 0, width: 24, height: 24 }),
    );
    useCustomizeStore.getState().register(a);
    useCustomizeStore.getState().register(b);

    render(<CustomizeOverlay />);

    const proxies = document.querySelectorAll<HTMLButtonElement>(
      "[data-customize-proxy]",
    );
    expect(proxies).toHaveLength(2);
    const labels = [...proxies].map((proxy) =>
      proxy.getAttribute("aria-label"),
    );
    expect(labels).toContain(
      `Customize ${getCustomizeSetting("composer.mic").label}, visible`,
    );
    expect(labels).toContain(
      `Customize ${getCustomizeSetting("tabs.home").label}, visible`,
    );
  });

  it("a ResizeObserver callback firing re-measures and moves the proxy", async () => {
    const original = globalThis.ResizeObserver;
    ControllableResizeObserver.instances = [];
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ControllableResizeObserver,
    });
    try {
      const node = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
      const a = instance("composer.mic", node);
      useCustomizeStore.getState().register(a);
      render(<CustomizeOverlay />);
      await waitFor(() => expect(proxyFor(a.key)).not.toBeNull());
      expect(proxyFor(a.key)?.style.width).toBe("24px");

      stubRect(node, { x: 0, y: 0, width: 60, height: 60 });
      act(() => {
        ControllableResizeObserver.instances.forEach((observer) =>
          observer.trigger(),
        );
      });

      await waitFor(() => expect(proxyFor(a.key)?.style.width).toBe("60px"));
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it("removing a registered node moves focus to the remaining proxy", async () => {
    const nodeA = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const nodeB = fixtureNode({ x: 100, y: 0, width: 24, height: 24 });
    const a = instance("composer.mic", nodeA);
    const b = instance("tabs.home", nodeB);
    useCustomizeStore.getState().register(a);
    useCustomizeStore.getState().register(b);
    render(<CustomizeOverlay />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-customize-proxy]")).toHaveLength(
        2,
      ),
    );
    act(() => {
      useCustomizeStore.getState().setActive(a.key);
    });

    act(() => {
      useCustomizeStore.getState().unregister(a.key, nodeA);
    });

    await waitFor(() => expect(document.activeElement).toBe(proxyFor(b.key)));
  });

  it("marks data-customize-inert chrome inert while live, and clears it once the session ends", async () => {
    const chrome = document.createElement("div");
    chrome.setAttribute("data-customize-inert", "");
    document.body.appendChild(chrome);

    render(<CustomizeOverlay />);

    await waitFor(() => expect(chrome.hasAttribute("inert")).toBe(true));

    act(() => {
      useCustomizeStore.setState({ session: null });
    });

    await waitFor(() => expect(chrome.hasAttribute("inert")).toBe(false));
  });

  it("arrow keys move focus between proxies in DOM order", () => {
    // Document order matters here: `selectedInstances` sorts by the
    // instance's own node position, and DOM traversal reads proxies in the
    // order they were rendered - both keyed off where these nodes actually
    // sit in the document, not registration order.
    const nodeA = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const nodeB = fixtureNode({ x: 100, y: 0, width: 24, height: 24 });
    const a = instance("composer.mic", nodeA);
    const b = instance("tabs.home", nodeB);
    useCustomizeStore.getState().register(a);
    useCustomizeStore.getState().register(b);
    render(<CustomizeOverlay />);
    const proxies = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-customize-proxy]"),
    ];
    expect(proxies).toHaveLength(2);
    proxies[0]?.focus();
    expect(document.activeElement).toBe(proxies[0]);

    act(() => {
      proxies[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });

    expect(document.activeElement).toBe(proxies[1]);
  });

  it("Escape with nothing open exits the session, through handleCustomizeKeydown", () => {
    render(<CustomizeOverlay />);
    expect(useCustomizeStore.getState().session).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(useCustomizeStore.getState().session).toBeNull();
  });

  it("Escape closes an open popover first, rather than exiting", () => {
    const a = instance(
      "composer.mic",
      fixtureNode({ x: 0, y: 0, width: 24, height: 24 }),
    );
    useCustomizeStore.getState().register(a);
    useCustomizeStore.setState({ popoverKey: a.key, invoker: a.key });
    render(<CustomizeOverlay />);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(useCustomizeStore.getState().popoverKey).toBeNull();
    expect(useCustomizeStore.getState().session).not.toBeNull();
  });
  // Review w2, finding 1: removing the target behind an OPEN popover must
  // land focus on the overlay's own chosen destination (the nearest
  // remaining proxy) and KEEP it there through Radix's own, separately
  // timed close-autofocus callback - not have that later callback's
  // first-proxy fallback override it.
  it("removing the node behind an open popover keeps focus on the overlay's chosen destination through Radix's delayed close-autofocus", async () => {
    const nodeA = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const nodeB = fixtureNode({ x: 50, y: 0, width: 24, height: 24 });
    const nodeC = fixtureNode({ x: 100, y: 0, width: 24, height: 24 });
    const a = instance("composer.mic", nodeA);
    const b = instance("tabs.home", nodeB);
    const c = instance("chat.minimapSide", nodeC);
    useCustomizeStore.getState().register(a);
    useCustomizeStore.getState().register(b);
    useCustomizeStore.getState().register(c);
    render(<CustomizeOverlay />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-customize-proxy]")).toHaveLength(
        3,
      ),
    );

    act(() => {
      useCustomizeStore.setState({
        popoverKey: b.key,
        activeKey: b.key,
        invoker: b.key,
      });
    });

    act(() => {
      useCustomizeStore.getState().unregister(b.key, nodeB);
    });

    await waitFor(() => expect(document.activeElement).toBe(proxyFor(c.key)));

    // Give Radix's own (asynchronous, separately timed) close-autofocus
    // callback room to fire, then confirm it did not later move focus to A.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(document.activeElement).toBe(proxyFor(c.key));
    expect(document.activeElement).not.toBe(proxyFor(a.key));
  });

  // Review w2, finding 2: the overlay's own outside-click listener already
  // excludes the bar, but Radix's Popover runs its OWN, separate dismissal
  // path (pointer/focus-outside detection against its portalled content),
  // which is not gated by that listener at all.
  describe("interaction with an open popover while the bar is present", () => {
    it("clicking the bar's search field does not dismiss the open popover", async () => {
      const a = instance(
        "composer.mic",
        fixtureNode({ x: 0, y: 0, width: 24, height: 24 }),
      );
      useCustomizeStore.getState().register(a);
      useCustomizeStore.setState({ popoverKey: a.key, invoker: a.key });
      render(<CustomizeOverlay />);
      const search = document.querySelector<HTMLInputElement>(
        "[data-customize-search]",
      );
      expect(search).not.toBeNull();
      if (search === null)
        throw new Error("search input not found in the rendered bar");

      await userEvent.setup().click(search);
      expect(document.activeElement).toBe(search);
      expect(useCustomizeStore.getState().popoverKey).toBe(a.key);
    });

    it("an actual click outside the editor still closes the open popover", () => {
      const a = instance(
        "composer.mic",
        fixtureNode({ x: 0, y: 0, width: 24, height: 24 }),
      );
      useCustomizeStore.getState().register(a);
      useCustomizeStore.setState({ popoverKey: a.key, invoker: a.key });
      render(<CustomizeOverlay />);
      const outside = document.createElement("div");
      document.body.appendChild(outside);

      act(() => {
        fireEvent.pointerDown(outside);
        fireEvent.click(outside);
      });

      expect(useCustomizeStore.getState().popoverKey).toBeNull();
      outside.remove();
    });
  });

  // Review w2, finding 4: search selection lives in `search.activeIndex`,
  // which stays set even when `activeKey` is null (an absent setting or any
  // preset result). The first Escape must clear that selection, not the
  // query - the query is a second Escape's job.
  it("Escape clears an active preset selection before it clears the query", () => {
    render(<CustomizeOverlay />);
    const search = document.querySelector<HTMLInputElement>(
      "[data-customize-search]",
    );
    expect(search).not.toBeNull();
    if (search === null)
      throw new Error("search input not found in the rendered bar");

    act(() => {
      fireEvent.change(search, { target: { value: "compact preset" } });
    });
    act(() => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
    });
    expect(useCustomizeStore.getState().search.activeIndex).toBe(0);
    expect(useCustomizeStore.getState().activeKey).toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(useCustomizeStore.getState().search.query).toBe("compact preset");
    expect(useCustomizeStore.getState().search.activeIndex).toBe(-1);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(useCustomizeStore.getState().search.query).toBe("");
  });

  // Review w2, finding 5: proxies are a single composite for Tab purposes.
  // Exactly one carries a real tab stop at a time (a roving tabindex), it
  // moves with arrow-key focus, and Tab leaves the whole composite instead
  // of walking every proxy.
  it("exactly one proxy is a tab stop, arrow keys move it, and Tab leaves the composite toward the bar", async () => {
    const nodeA = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const nodeB = fixtureNode({ x: 50, y: 0, width: 24, height: 24 });
    const a = instance("composer.mic", nodeA);
    const b = instance("tabs.home", nodeB);
    useCustomizeStore.getState().register(a);
    useCustomizeStore.getState().register(b);
    render(<CustomizeOverlay />);
    const proxies = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-customize-proxy]"),
    ];
    expect(proxies).toHaveLength(2);
    const tabStops = () => proxies.filter((proxy) => proxy.tabIndex === 0);
    expect(tabStops()).toHaveLength(1);

    const firstProxy = proxies[0];
    const secondProxy = proxies[1];
    act(() => {
      firstProxy.focus();
    });

    act(() => {
      firstProxy.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });

    await waitFor(() => expect(tabStops()).toHaveLength(1));
    expect(tabStops()[0]).toBe(secondProxy);
    expect(firstProxy.tabIndex).toBe(-1);

    const user = userEvent.setup();
    await user.tab();

    expect(document.activeElement).not.toBe(firstProxy);
    expect(document.activeElement).not.toBe(secondProxy);
    expect(
      document.activeElement?.closest("[data-customize-bar]"),
    ).not.toBeNull();
  });

  // Review w2, finding 7: a search-highlighted proxy must show its name
  // label even though DOM focus stays in the search input the whole time.
  it("a search-highlighted proxy's label stays shown while the search input keeps focus", () => {
    const node = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const a = instance("composer.mic", node);
    useCustomizeStore.getState().register(a);
    render(<CustomizeOverlay />);
    const search = document.querySelector<HTMLInputElement>(
      "[data-customize-search]",
    );
    expect(search).not.toBeNull();
    if (search === null)
      throw new Error("search input not found in the rendered bar");
    search.focus();

    act(() => {
      fireEvent.change(search, { target: { value: "mic" } });
    });
    act(() => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
    });

    expect(useCustomizeStore.getState().activeKey).toBe(a.key);
    expect(document.activeElement).toBe(search);
    const label = getCustomizeSetting("composer.mic").label;
    // `[data-slot="tooltip-content"]` is this codebase's own wrapper marker
    // (`src/components/ui/tooltip.tsx`), not a Radix internal to guess at.
    const tooltips = [
      ...document.querySelectorAll('[data-slot="tooltip-content"]'),
    ];
    expect(
      tooltips.some((tooltip) => tooltip.textContent.includes(label)),
    ).toBe(true);
  });
  it("Tab inside the open hotspot form still wraps last-to-first through the real Radix FocusScope after a detour through search", async () => {
    const a = instance(
      "composer.mic",
      fixtureNode({ x: 0, y: 0, width: 24, height: 24 }),
    );
    useCustomizeStore.getState().register(a);
    const control: CustomizeControl = {
      kind: "multi",
      id: "fixture.primary",
      label: "Primary setting",
      touches: ["composer"],
      analytics: "layout.composer.mic",
      values: [],
      lastItemHeld: false,
      options: [
        { value: "a", label: "Option A", picture: null, override: {} },
        { value: "b", label: "Option B", picture: null, override: {} },
      ],
      change: () => undefined,
    };
    const options: CustomizeOptions = {
      state: "Option A",
      control,
      moves: [],
      drag: null,
    };
    const unregisterOptions = registerCustomizeOptions(
      "composer.mic",
      () => options,
    );
    try {
      act(() => {
        useCustomizeStore.setState({ popoverKey: a.key, invoker: a.key });
      });
      render(<CustomizeOverlay />);
      const controls = () => [
        ...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'),
      ];
      await waitFor(() => expect(controls()).toHaveLength(2));
      const [firstControl, lastControl] = controls();

      const search = document.querySelector<HTMLInputElement>(
        "[data-customize-search]",
      );
      if (search === null)
        throw new Error("search input not found in the rendered bar");
      const user = userEvent.setup();
      await user.click(search);
      await user.keyboard("m");
      expect(useCustomizeStore.getState().search.query).toBe("m");

      await user.click(lastControl);
      expect(document.activeElement).toBe(lastControl);

      await user.tab();

      expect(document.activeElement).toBe(firstControl);
    } finally {
      unregisterOptions();
    }
  });
});
