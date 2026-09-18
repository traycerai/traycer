import { act, cleanup, render, waitFor } from "@testing-library/react";
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
});
