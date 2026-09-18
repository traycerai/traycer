import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHotspotRects } from "@/components/customize/use-hotspot-rects";
import type { HotspotInstance } from "@/stores/customize/customize-store";

// jsdom does no layout, so a plain `document.createElement` measures as an
// all-zero rect - which the hook itself would then (correctly) call
// unreachable. Stub the two DOM reads the hook actually uses instead of
// faking layout.
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

function makeInstance(key: string, node: HTMLElement): HotspotInstance {
  return {
    key,
    settingId: "composer.mic",
    sceneId: "shell",
    tileId: null,
    node,
    ghost: false,
    condition: null,
  };
}

// A controllable stand-in for jsdom's missing `ResizeObserver`, so a resize
// can be driven deterministically instead of waiting on real layout that
// jsdom never produces.
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

let originalResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  ControllableResizeObserver.instances = [];
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ControllableResizeObserver,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: originalResizeObserver,
  });
  document.body.innerHTML = "";
});

describe("useHotspotRects", () => {
  it("measures each connected, visible instance on mount", () => {
    const node = fixtureNode({ x: 10, y: 10, width: 24, height: 24 });
    const instances = new Map([["a", makeInstance("a", node)]]);

    const { result } = renderHook(() => useHotspotRects(instances));

    expect(result.current.unreachable.has("a")).toBe(false);
    expect(result.current.rects.get("a")?.width).toBe(24);
  });

  it("a ResizeObserver callback firing re-measures and reports the new rect", async () => {
    const node = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const instances = new Map([["a", makeInstance("a", node)]]);
    const { result } = renderHook(() => useHotspotRects(instances));
    expect(result.current.rects.get("a")?.width).toBe(24);

    stubRect(node, { x: 0, y: 0, width: 50, height: 50 });
    act(() => {
      ControllableResizeObserver.instances.forEach((observer) =>
        observer.trigger(),
      );
    });

    await waitFor(() => expect(result.current.rects.get("a")?.width).toBe(50));
  });

  it("a node removed from the document is reported unreachable, not left with a stale rect", async () => {
    const node = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const instances = new Map([["a", makeInstance("a", node)]]);
    const { result } = renderHook(() => useHotspotRects(instances));
    expect(result.current.unreachable.has("a")).toBe(false);

    node.remove();
    // The hook also watches childList mutations on `document.body`, so a
    // real removal alone re-triggers it; forcing the observer too keeps this
    // deterministic instead of depending on jsdom's MutationObserver timing.
    act(() => {
      ControllableResizeObserver.instances.forEach((observer) =>
        observer.trigger(),
      );
    });

    await waitFor(() => expect(result.current.unreachable.has("a")).toBe(true));
    expect(result.current.rects.has("a")).toBe(false);
  });
});
