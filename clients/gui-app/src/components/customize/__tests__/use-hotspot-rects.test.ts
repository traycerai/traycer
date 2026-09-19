import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
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
  cleanup();
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

// The hook coalesces everything that can change a rect - a streaming
// transcript appending nodes, scrolls, resizes - into one measurement per
// animation frame. jsdom's own rAF is timer-driven and would race the
// assertions, so a manually flushed queue stands in for it.
describe("useHotspotRects - frame coalescing", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let requestFrame: MockInstance<typeof window.requestAnimationFrame>;
  let cancelFrame: MockInstance<typeof window.cancelAnimationFrame>;
  // Who asked for each frame, so a count mismatch names its source instead of
  // guessing (anything in the tree may call rAF, not only the hook).
  let frameSources: string[];

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 1;
    frameSources = [];
    requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        frameSources.push(
          (new Error().stack ?? "").split("\n").slice(2, 6).join(" | "),
        );
        return id;
      });
    cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
  });

  afterEach(() => {
    // Explicit: a hook left mounted would keep observing `document.body` and
    // request frames on every later test's mutations.
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * Runs every pending frame and returns how many of them were HOOK
   * measurements (a frame during which the node's rect was read), so a test
   * can assert "exactly one measuring frame" regardless of unrelated frames.
   */
  function flushFrames(
    measure: MockInstance<HTMLElement["getBoundingClientRect"]> | null,
  ): number {
    const pending = [...frames.values()];
    frames.clear();
    let measuring = 0;
    act(() => {
      for (const callback of pending) {
        const readsBefore = measure?.mock.calls.length ?? 0;
        callback(performance.now());
        if (measure !== null && measure.mock.calls.length > readsBefore)
          measuring += 1;
      }
    });
    return measuring;
  }

  // MutationObserver callbacks are microtasks; let them run before asserting.
  async function settleMutations(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function mountMeasured() {
    const node = fixtureNode({ x: 0, y: 0, width: 24, height: 24 });
    const measure = vi.spyOn(node, "getBoundingClientRect");
    const instances = new Map([["a", makeInstance("a", node)]]);
    const hook = renderHook(() => useHotspotRects(instances));
    measure.mockClear();
    requestFrame.mockClear();
    return { node, measure, hook };
  }

  it("a burst of streamed DOM appends schedules one frame and yields one measurement", async () => {
    const { measure, hook } = mountMeasured();
    const versionBefore = hook.result.current.version;
    const transcript = document.createElement("div");
    document.body.appendChild(transcript);

    for (let index = 0; index < 50; index += 1) {
      const line = document.createElement("p");
      line.textContent = `token ${index}`;
      transcript.appendChild(line);
    }
    await settleMutations();

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(measure).not.toHaveBeenCalled();

    flushFrames(measure);

    expect(measure).toHaveBeenCalledTimes(1);
    expect(hook.result.current.version).toBe(versionBefore + 1);
  });

  it("mixed scroll, resize and mutation signals inside one frame still coalesce", async () => {
    const { measure, hook } = mountMeasured();
    const versionBefore = hook.result.current.version;

    document.body.appendChild(document.createElement("span"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    act(() => {
      ControllableResizeObserver.instances.forEach((observer) =>
        observer.trigger(),
      );
    });
    await settleMutations();

    expect(requestFrame).toHaveBeenCalledTimes(1);
    flushFrames(measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(hook.result.current.version).toBe(versionBefore + 1);
  });

  it("schedules a fresh frame for the next change once the previous frame has run", async () => {
    const { measure, hook } = mountMeasured();
    const versionBefore = hook.result.current.version;

    document.body.appendChild(document.createElement("span"));
    await settleMutations();
    // Exactly one measuring frame. Frames the tree requests for other reasons
    // are allowed; `frameSources` names them if this count is ever off.
    expect(flushFrames(measure), frameSources.join("\n")).toBe(1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(hook.result.current.version).toBe(versionBefore + 1);

    frameSources.length = 0;
    document.body.appendChild(document.createElement("span"));
    await settleMutations();

    // Not stuck after a run: the next change gets exactly one new measuring
    // frame.
    expect(flushFrames(measure), frameSources.join("\n")).toBe(1);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(hook.result.current.version).toBe(versionBefore + 2);
  });

  it("ignores attribute churn outside the observed filter (class and style streaming)", async () => {
    const { node } = mountMeasured();

    node.className = "streaming";
    node.style.opacity = "0.5";
    node.setAttribute("data-other", "1");
    await settleMutations();

    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("reacts to the observed visibility attributes", async () => {
    const { node, measure, hook } = mountMeasured();

    node.setAttribute("aria-hidden", "true");
    await settleMutations();
    flushFrames(measure);

    expect(hook.result.current.unreachable.has("a")).toBe(true);
  });

  it("unmounting cancels the pending frame and never measures or updates afterwards", async () => {
    const { measure, hook } = mountMeasured();
    document.body.appendChild(document.createElement("span"));
    await settleMutations();
    expect(frames.size).toBe(1);

    hook.unmount();

    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    flushFrames(measure);
    expect(measure).not.toHaveBeenCalled();
    // Torn down listeners: later changes schedule nothing.
    requestFrame.mockClear();
    document.body.appendChild(document.createElement("span"));
    window.dispatchEvent(new Event("scroll"));
    await settleMutations();
    expect(requestFrame).not.toHaveBeenCalled();
  });
});

// Clipping. A hotspot inside a horizontally/vertically clipped ancestor (a
// provider chip cut off by the strip beside it) must not report its raw
// box: the overlay's proxy would be expanded to 24px and cross the clip edge
// onto the neighbouring control. The reported rect is the node's box
// intersected with the viewport and every clipping ancestor's box; less than
// 24px visible on either axis is "unreachable".
//
// ASSUMPTIONS the production fix must satisfy (adjust here if it differs):
// - an ancestor clips an axis when its computed `overflow-x`/`overflow-y` is
//   hidden, clip, auto or scroll; `visible` never clips;
// - the ancestor's clip box is its padding box: `getBoundingClientRect()`
//   origin plus `clientLeft`/`clientTop`, sized `clientWidth`/`clientHeight`
//   (so borders and scrollbars are excluded; stubbed below);
// - the viewport is `window.innerWidth`/`innerHeight`;
// - 24 visible px is reachable (`>=`), 23.x is not - but only when the rect
//   was actually clipped: a tiny, wholly visible hotspot stays reachable and
//   keeps its own box (the overlay expands it to 24px, per the existing spec).
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const box = (rect: DOMRect | undefined): Box | undefined =>
  rect === undefined
    ? undefined
    : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

interface Inset {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
const NO_INSET: Inset = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * An element with the given clip style and box, appended into `parent`. Its
 * clip (padding) box defaults to the whole border box; pass `inset` to model a
 * border (`left`/`top`) and a scrollbar/border (`right`/`bottom`).
 */
function clipper(
  parent: HTMLElement,
  style: { readonly overflowX: string; readonly overflowY: string },
  rect: Box,
  inset: Inset,
): HTMLElement {
  const element = document.createElement("div");
  element.style.setProperty("overflow-x", style.overflowX);
  element.style.setProperty("overflow-y", style.overflowY);
  parent.appendChild(element);
  stubRect(element, rect);
  // jsdom does no layout, so the client* metrics the hook reads are stubbed
  // alongside the bounding box.
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

function measure(node: HTMLElement) {
  const instances = new Map([["a", makeInstance("a", node)]]);
  return renderHook(() => useHotspotRects(instances));
}

const CLIPPING = ["hidden", "clip", "auto", "scroll"] as const;

describe("useHotspotRects - clipping ancestors and viewport", () => {
  it("reports the raw box for a node whose ancestors do not clip", () => {
    const parent = clipper(
      document.body,
      { overflowX: "visible", overflowY: "visible" },
      { x: 0, y: 0, width: 50, height: 50 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 70, y: 10, width: 60, height: 30 });

    const { result } = measure(node);

    expect(box(result.current.rects.get("a"))).toEqual({
      x: 70,
      y: 10,
      width: 60,
      height: 30,
    });
  });

  it.each(CLIPPING)(
    "a %s ancestor clips the reported rect to its own box when at least 24px stay visible",
    (overflow) => {
      const parent = clipper(
        document.body,
        { overflowX: overflow, overflowY: overflow },
        { x: 0, y: 0, width: 100, height: 100 },
        NO_INSET,
      );
      const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 30 });

      const { result } = measure(node);

      expect(result.current.unreachable.has("a")).toBe(false);
      expect(box(result.current.rects.get("a"))).toEqual({
        x: 70,
        y: 10,
        width: 30,
        height: 30,
      });
    },
  );

  it("treats exactly 24px visible as reachable and less as unavailable", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "visible" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const exact = nodeIn(parent, { x: 76, y: 10, width: 40, height: 30 });
    const short = nodeIn(parent, { x: 77, y: 10, width: 40, height: 30 });

    const shown = measure(exact);
    const hidden = measure(short);

    expect(shown.result.current.rects.get("a")?.width).toBe(24);
    expect(hidden.result.current.unreachable.has("a")).toBe(true);
    expect(hidden.result.current.rects.has("a")).toBe(false);
  });

  it("a node clipped entirely away is unavailable, never a zero or negative rect", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 150, y: 10, width: 40, height: 30 });

    const { result } = measure(node);

    expect(result.current.unreachable.has("a")).toBe(true);
    expect(result.current.rects.has("a")).toBe(false);
  });

  it("clips only the axis the ancestor clips", () => {
    const parent = clipper(
      document.body,
      { overflowX: "visible", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    // Far outside the parent horizontally, straddling its bottom edge.
    const node = nodeIn(parent, { x: 300, y: 70, width: 60, height: 60 });

    const { result } = measure(node);

    expect(box(result.current.rects.get("a"))).toEqual({
      x: 300,
      y: 70,
      width: 60,
      height: 30,
    });
  });

  it("intersects nested ancestors that clip different axes", () => {
    const outer = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "visible" },
      { x: 0, y: 0, width: 200, height: 500 },
      NO_INSET,
    );
    // A non-clipping wrapper in between must not interrupt the walk.
    const wrapper = clipper(
      outer,
      { overflowX: "visible", overflowY: "visible" },
      { x: 0, y: 0, width: 400, height: 500 },
      NO_INSET,
    );
    const inner = clipper(
      wrapper,
      { overflowX: "visible", overflowY: "hidden" },
      { x: 0, y: 0, width: 400, height: 60 },
      NO_INSET,
    );
    const wide = nodeIn(inner, { x: 150, y: 20, width: 100, height: 40 });
    const shortAfterClip = nodeIn(inner, {
      x: 150,
      y: 40,
      width: 100,
      height: 40,
    });

    const clipped = measure(wide);
    const tooShort = measure(shortAfterClip);

    // x is cut by the outer box (200), y by the inner box (60): 50 x 40.
    expect(box(clipped.result.current.rects.get("a"))).toEqual({
      x: 150,
      y: 20,
      width: 50,
      height: 40,
    });
    // Only 20px of height survives the inner box -> unavailable.
    expect(tooShort.result.current.unreachable.has("a")).toBe(true);
  });

  it("clips to the padding box: a border and a scrollbar are not visible area", () => {
    // Border box 0..100 with a 2px border and an 8px scrollbar on the right:
    // the clip box is x 2..92.
    const parent = clipper(
      document.body,
      { overflowX: "auto", overflowY: "visible" },
      { x: 0, y: 0, width: 100, height: 100 },
      { left: 2, top: 0, right: 8, bottom: 0 },
    );
    const node = nodeIn(parent, { x: 60, y: 10, width: 60, height: 30 });
    const underScrollbar = nodeIn(parent, {
      x: 70,
      y: 10,
      width: 60,
      height: 30,
    });

    const shown = measure(node);
    const hidden = measure(underScrollbar);

    // 60..92 = 32px, not 40 (which the border box would give).
    expect(shown.result.current.rects.get("a")?.width).toBe(32);
    // 70..92 = 22px < 24 -> unavailable, though the border box would allow 30.
    expect(hidden.result.current.unreachable.has("a")).toBe(true);
  });

  it("a small hotspot that is wholly visible inside a clipping ancestor stays reachable with its own box", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 10, y: 10, width: 10, height: 12 });

    const { result } = measure(node);

    expect(result.current.unreachable.has("a")).toBe(false);
    expect(box(result.current.rects.get("a"))).toEqual({
      x: 10,
      y: 10,
      width: 10,
      height: 12,
    });
  });

  it("clips to the viewport as well", () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 100,
    });
    try {
      const partly = nodeIn(document.body, {
        x: 60,
        y: 10,
        width: 60,
        height: 30,
      });
      const barely = nodeIn(document.body, {
        x: 90,
        y: 10,
        width: 60,
        height: 30,
      });

      const shown = measure(partly);
      const hidden = measure(barely);

      expect(shown.result.current.rects.get("a")?.width).toBe(40);
      expect(hidden.result.current.unreachable.has("a")).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: innerWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: innerHeight,
      });
    }
  });

  it("a scroll inside the clipping ancestor re-measures the clipped rect", async () => {
    const parent = clipper(
      document.body,
      { overflowX: "auto", overflowY: "visible" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 60, y: 10, width: 60, height: 30 });
    const { result } = measure(node);
    expect(result.current.rects.get("a")?.width).toBe(40);

    // The content scrolls left: the node moves fully inside the clip box.
    stubRect(node, { x: 10, y: 10, width: 60, height: 30 });
    act(() => {
      parent.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() =>
      expect(box(result.current.rects.get("a"))).toEqual({
        x: 10,
        y: 10,
        width: 60,
        height: 30,
      }),
    );

    // ...and scrolling it back out past the edge makes it unavailable.
    stubRect(node, { x: 95, y: 10, width: 60, height: 30 });
    act(() => {
      parent.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(result.current.unreachable.has("a")).toBe(true));
  });
});
