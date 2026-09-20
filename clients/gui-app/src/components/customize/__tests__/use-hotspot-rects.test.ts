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
import {
  type HotspotRects,
  useHotspotRects,
} from "@/components/customize/use-hotspot-rects";
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
    expect(result.current.hitRects.get("a")?.width).toBe(24);
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
// provider chip cut off by the strip beside it) must neither report its raw
// box nor be given a hit target that crosses the clip edge onto a neighbour.
//
// CONTRACT under test:
// - `rects` is the SOURCE rectangle: the node's box intersected with the
//   viewport and every clipping ancestor's padding box (scrim cut-out and
//   popover anchor use it).
// - a hotspot is unreachable when it is clipped away entirely, OR when its
//   cumulative clip is under 24px on either axis (a 24px target cannot fit
//   without crossing the clip edge).
// - `hitRects` is what the proxy paints, exactly: per axis, the visible extent
//   expanded to at least 24px (the clip is >= 24px, so it always fits),
//   positioned around the visible rect and shifted to stay inside the
//   cumulative clip.
// - a CLIPPED hotspot (visible area < source area) is only reachable if its
//   hit box overlaps no hotspot already accepted. Candidates are considered
//   least-clipped first (visible/source area ratio, descending), then in
//   DOCUMENT order - never registration order.
// - `rects`, `hitRects` and `unreachable` always agree: a key is in `rects`
//   and `hitRects` exactly when it is not in `unreachable`.
// - an ancestor clips an axis when its computed `overflow-x`/`overflow-y` is
//   hidden, clip, auto or scroll; `visible` never clips;
// - the clip box is the ancestor's padding box: `getBoundingClientRect()`
//   origin plus `clientLeft`/`clientTop`, sized `clientWidth`/`clientHeight`
//   (borders and scrollbars excluded; stubbed below);
// - the viewport is `window.innerWidth`/`innerHeight` and is part of the
//   cumulative clip.
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
 * clip (padding) box is the border box less `inset` - a border on
 * `left`/`top`, a border or scrollbar on `right`/`bottom`.
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
  restubClient(element, rect, inset);
  return element;
}

/** jsdom does no layout, so the client* metrics the hook reads are stubbed. */
function restubClient(element: HTMLElement, rect: Box, inset: Inset): void {
  const metrics: Record<string, number> = {
    clientLeft: inset.left,
    clientTop: inset.top,
    clientWidth: rect.width - inset.left - inset.right,
    clientHeight: rect.height - inset.top - inset.bottom,
  };
  for (const [name, value] of Object.entries(metrics))
    Object.defineProperty(element, name, { configurable: true, value });
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

/** A hook over several hotspots, registered in the given order. */
function measureAll(entries: ReadonlyArray<readonly [string, HTMLElement]>) {
  const instances = new Map<string, HotspotInstance>();
  for (const [key, node] of entries)
    instances.set(key, makeInstance(key, node));
  return renderHook(() => useHotspotRects(instances));
}

/** `rects`, `hitRects` and `unreachable` tell the same story for each key. */
function expectConsistent(
  result: { readonly current: HotspotRects },
  keys: ReadonlyArray<string>,
): void {
  for (const key of keys) {
    const reachable = result.current.rects.has(key);
    expect(result.current.hitRects.has(key), `${key} hitRects`).toBe(reachable);
    expect(result.current.unreachable.has(key), `${key} unreachable`).toBe(
      !reachable,
    );
  }
}

/** Both published rectangles for the one hotspot the tests mount. */
function published(result: { readonly current: HotspotRects }) {
  return {
    source: box(result.current.rects.get("a")),
    hit: box(result.current.hitRects.get("a")),
  };
}

const CLIPPING = ["hidden", "clip", "auto", "scroll"] as const;

describe("useHotspotRects - clipping ancestors and viewport", () => {
  it("reports the raw box, and a hit box equal to it, when no ancestor clips", () => {
    const parent = clipper(
      document.body,
      { overflowX: "visible", overflowY: "visible" },
      { x: 0, y: 0, width: 50, height: 50 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 70, y: 10, width: 60, height: 30 });

    const { result } = measure(node);

    const raw = { x: 70, y: 10, width: 60, height: 30 };
    expect(published(result)).toEqual({ source: raw, hit: raw });
  });

  it.each(CLIPPING)(
    "a %s ancestor clips the source rect to its own box; a hit box already 24px both ways is unchanged",
    (overflow) => {
      const parent = clipper(
        document.body,
        { overflowX: overflow, overflowY: overflow },
        { x: 0, y: 0, width: 100, height: 100 },
        NO_INSET,
      );
      const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 30 });

      const { result } = measure(node);

      const clipped = { x: 70, y: 10, width: 30, height: 30 };
      expect(result.current.unreachable.has("a")).toBe(false);
      expect(published(result)).toEqual({ source: clipped, hit: clipped });
    },
  );

  it("expands a short clipped source to 24px vertically without leaving the clip", () => {
    // Source 70..120 x 10..26; clip 0..100 x 10..50 -> visible 30 x 16.
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 10, width: 100, height: 40 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    const { result } = measure(node);

    expect(published(result)).toEqual({
      source: { x: 70, y: 10, width: 30, height: 16 },
      hit: { x: 70, y: 10, width: 30, height: 24 },
    });
  });

  it("expands a narrow clipped source to 24px horizontally without leaving the clip (mirror)", () => {
    // Source 10..26 x 70..120; clip 10..50 x 0..100 -> visible 16 x 30.
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 10, y: 0, width: 40, height: 100 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 10, y: 70, width: 16, height: 50 });

    const { result } = measure(node);

    expect(published(result)).toEqual({
      source: { x: 10, y: 70, width: 16, height: 30 },
      hit: { x: 10, y: 70, width: 24, height: 30 },
    });
  });

  it("a clip under 24px on either axis makes the hotspot unreachable, even a wholly visible one", () => {
    // 20px tall clip (y 10..30) around a source that would otherwise expand.
    const vertical = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 10, width: 100, height: 20 },
      NO_INSET,
    );
    const tall = nodeIn(vertical, { x: 70, y: 10, width: 50, height: 16 });
    // Mirror: a 20px wide clip (x 10..30).
    const horizontal = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 10, y: 0, width: 20, height: 100 },
      NO_INSET,
    );
    const wide = nodeIn(horizontal, { x: 10, y: 70, width: 16, height: 50 });
    // Wholly visible inside a 20px clip: still no room for a 24px target.
    const snug = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 200, width: 100, height: 20 },
      NO_INSET,
    );
    const tiny = nodeIn(snug, { x: 10, y: 205, width: 10, height: 10 });

    const shortClip = measure(tall);
    const narrowClip = measure(wide);
    const wholly = measure(tiny);

    for (const hook of [shortClip, narrowClip, wholly]) {
      expect(hook.result.current.unreachable.has("a")).toBe(true);
      expectConsistent(hook.result, ["a"]);
    }
  });

  it("just reaching 24px on the clip's tighter axis stays reachable", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 10, width: 100, height: 24 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 70, y: 10, width: 50, height: 16 });

    const { result } = measure(node);

    expect(published(result)).toEqual({
      source: { x: 70, y: 10, width: 30, height: 16 },
      hit: { x: 70, y: 10, width: 30, height: 24 },
    });
  });

  it("a lone clipped sliver of any size is reachable: source is the sliver, hit is 24px shifted back inside the clip", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "visible" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const ten = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
    const twentyThree = nodeIn(parent, { x: 77, y: 10, width: 40, height: 30 });
    const exactly24 = nodeIn(parent, { x: 76, y: 10, width: 40, height: 30 });

    const sliver = measure(ten);
    const almost = measure(twentyThree);
    const exact = measure(exactly24);

    // Visible 10 / 23 / 24px: all reachable, all get the same 24px target
    // ending flush with the clip's right edge (x 76..100).
    expect(published(sliver.result)).toEqual({
      source: { x: 90, y: 10, width: 10, height: 30 },
      hit: { x: 76, y: 10, width: 24, height: 30 },
    });
    expect(published(almost.result)).toEqual({
      source: { x: 77, y: 10, width: 23, height: 30 },
      hit: { x: 76, y: 10, width: 24, height: 30 },
    });
    expect(published(exact.result)).toEqual({
      source: { x: 76, y: 10, width: 24, height: 30 },
      hit: { x: 76, y: 10, width: 24, height: 30 },
    });
  });

  it("a node clipped entirely away is unreachable, never a zero or negative rect", () => {
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
    expect(result.current.hitRects.has("a")).toBe(false);
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

    const clipped = { x: 300, y: 70, width: 60, height: 30 };
    expect(published(result)).toEqual({ source: clipped, hit: clipped });
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
    const short = measure(shortAfterClip);

    // x is cut by the outer box (200), y by the inner box (60): 50 x 40.
    const both = { x: 150, y: 20, width: 50, height: 40 };
    expect(published(clipped.result)).toEqual({ source: both, hit: both });
    // Only 20px of height survives the inner box: the source stays 20px, the
    // hit box grows to 24px and is shifted up to end at the inner clip's edge.
    expect(published(short.result)).toEqual({
      source: { x: 150, y: 40, width: 50, height: 20 },
      hit: { x: 150, y: 36, width: 50, height: 24 },
    });
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
    const narrow = measure(underScrollbar);

    // 60..92 = 32px, not the 40 the border box would give.
    const padded = { x: 60, y: 10, width: 32, height: 30 };
    expect(published(shown.result)).toEqual({ source: padded, hit: padded });
    // 70..92 = 22px: reachable, expanded to 24 ending at the padding edge.
    expect(published(narrow.result)).toEqual({
      source: { x: 70, y: 10, width: 22, height: 30 },
      hit: { x: 68, y: 10, width: 24, height: 30 },
    });
  });

  it("a small hotspot wholly visible inside a clipping ancestor keeps its own source box and is expanded to 24px inside the clip", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const node = nodeIn(parent, { x: 10, y: 10, width: 10, height: 12 });

    const { result } = measure(node);

    expect(result.current.unreachable.has("a")).toBe(false);
    expect(published(result)).toEqual({
      source: { x: 10, y: 10, width: 10, height: 12 },
      hit: { x: 3, y: 4, width: 24, height: 24 },
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
      const sliver = measure(barely);

      const visible = { x: 60, y: 10, width: 40, height: 30 };
      expect(published(shown.result)).toEqual({
        source: visible,
        hit: visible,
      });
      expect(published(sliver.result)).toEqual({
        source: { x: 90, y: 10, width: 10, height: 30 },
        hit: { x: 76, y: 10, width: 24, height: 30 },
      });
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

  it("a scroll inside the clipping ancestor re-measures both rectangles", async () => {
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
    const inside = { x: 10, y: 10, width: 60, height: 30 };
    await waitFor(() =>
      expect(published(result)).toEqual({ source: inside, hit: inside }),
    );

    // Scrolled almost out: a 5px sliver, still reachable with a 24px target.
    stubRect(node, { x: 95, y: 10, width: 60, height: 30 });
    act(() => {
      parent.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() =>
      expect(published(result)).toEqual({
        source: { x: 95, y: 10, width: 5, height: 30 },
        hit: { x: 76, y: 10, width: 24, height: 30 },
      }),
    );

    // ...and scrolled fully out it is unreachable.
    stubRect(node, { x: 150, y: 10, width: 60, height: 30 });
    act(() => {
      parent.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(result.current.unreachable.has("a")).toBe(true));
    expect(result.current.hitRects.has("a")).toBe(false);
  });
});

// Overlap policy. A clipped sliver's expanded hit box can land on top of its
// neighbour; it may only exist where it covers no hotspot already accepted.
describe("useHotspotRects - clipped hotspots never overlap an accepted one", () => {
  function pairInClip() {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    // B is created (and so sits) BEFORE A in the document, so a pass that
    // fell back to document order would wrongly favour it.
    const b = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
    const a = nodeIn(parent, { x: 50, y: 10, width: 36, height: 30 });
    return { a, b };
  }

  it.each([
    ["A registered first", ["A", "B"]],
    ["B registered first", ["B", "A"]],
  ] as const)(
    "the wholly visible neighbour wins over the clipped sliver (%s)",
    (_name, order) => {
      const { a, b } = pairInClip();
      const nodes = { A: a, B: b };

      const { result } = measureAll(
        order.map((key): readonly [string, HTMLElement] => [key, nodes[key]]),
      );

      // A (ratio 1) is unchanged; B (10 of 40px visible, hit 76..100) would
      // cover A's 50..86, so it is unreachable.
      expect(result.current.rects.get("A")).toBeDefined();
      expect(box(result.current.hitRects.get("A"))).toEqual({
        x: 50,
        y: 10,
        width: 36,
        height: 30,
      });
      expect(box(result.current.rects.get("A"))).toEqual({
        x: 50,
        y: 10,
        width: 36,
        height: 30,
      });
      expect(result.current.unreachable.has("B")).toBe(true);
      expectConsistent(result, ["A", "B"]);
    },
  );

  it.each([
    ["P registered first", ["P", "Q"]],
    ["Q registered first", ["Q", "P"]],
  ] as const)(
    "equally clipped candidates go by document order, not registration order (%s)",
    (_name, order) => {
      const parent = clipper(
        document.body,
        { overflowX: "hidden", overflowY: "hidden" },
        { x: 0, y: 0, width: 100, height: 100 },
        NO_INSET,
      );
      // Identical boxes -> identical ratio and a guaranteed overlap.
      const p = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
      const q = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
      const nodes = { P: p, Q: q };

      const { result } = measureAll(
        order.map((key): readonly [string, HTMLElement] => [key, nodes[key]]),
      );

      expect(box(result.current.hitRects.get("P"))).toEqual({
        x: 76,
        y: 10,
        width: 24,
        height: 30,
      });
      expect(result.current.unreachable.has("Q")).toBe(true);
      expectConsistent(result, ["P", "Q"]);
    },
  );

  it("a less clipped candidate beats a more clipped one that comes first in the document", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    // Both are clipped; `wide` keeps 20 of 40px (ratio .5), `narrow` 10 of 40
    // (.25). `narrow` is first in the document AND registered first.
    const narrow = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });
    const wide = nodeIn(parent, { x: 80, y: 10, width: 40, height: 30 });

    const { result } = measureAll([
      ["narrow", narrow],
      ["wide", wide],
    ]);

    expect(result.current.unreachable.has("narrow")).toBe(true);
    expect(box(result.current.hitRects.get("wide"))).toEqual({
      x: 76,
      y: 10,
      width: 24,
      height: 30,
    });
    expectConsistent(result, ["narrow", "wide"]);
  });

  it("a clipped sliver that overlaps nothing accepted stays reachable next to one that does not touch it", () => {
    const parent = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const far = nodeIn(parent, { x: 0, y: 10, width: 36, height: 30 });
    const sliver = nodeIn(parent, { x: 90, y: 10, width: 40, height: 30 });

    const { result } = measureAll([
      ["far", far],
      ["sliver", sliver],
    ]);

    expect(box(result.current.hitRects.get("far"))).toEqual({
      x: 0,
      y: 10,
      width: 36,
      height: 30,
    });
    expect(box(result.current.hitRects.get("sliver"))).toEqual({
      x: 76,
      y: 10,
      width: 24,
      height: 30,
    });
    expectConsistent(result, ["far", "sliver"]);
  });
});

// One clip walk per measurement pass. Many hotspots share the same scroller
// (a provider strip full of chips); the scroller's computed style and box are
// read once per pass and shared, not once per chip, and a NEW pass never
// serves the previous pass's numbers.
describe("useHotspotRects - shared ancestor reads per pass", () => {
  function spyStyleReads(): Map<Element, number> {
    const original = window.getComputedStyle.bind(window);
    const reads = new Map<Element, number>();
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) => {
        reads.set(element, (reads.get(element) ?? 0) + 1);
        return original(element, pseudo);
      },
    );
    return reads;
  }

  it("N hotspots under one scroller read each ancestor's style once and the scroller's box once per pass", async () => {
    const reads = spyStyleReads();
    const scroller = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "visible" },
      { x: 0, y: 0, width: 300, height: 100 },
      NO_INSET,
    );
    const scrollerBox = vi.spyOn(scroller, "getBoundingClientRect");
    const instances = new Map<string, HotspotInstance>();
    const keys: string[] = [];
    // 24px chips on a 30px pitch: side by side, never overlapping unclipped.
    for (let index = 0; index < 8; index += 1) {
      const key = `chip-${index}`;
      keys.push(key);
      instances.set(
        key,
        makeInstance(
          key,
          nodeIn(scroller, { x: index * 30, y: 10, width: 24, height: 24 }),
        ),
      );
    }

    const { result } = renderHook(() => useHotspotRects(instances));

    // Pass 1 (mount): every chip fits the 300px scroller.
    expect(reads.get(scroller)).toBe(1);
    expect(scrollerBox).toHaveBeenCalledTimes(1);
    for (const [element, count] of reads)
      expect(count, element.tagName).toBeLessThanOrEqual(1);
    expect(result.current.hitRects.size).toBe(8);
    expect(result.current.rects.get("chip-7")?.width).toBe(24);
    expectConsistent(result, keys);

    // Pass 2: the scroller narrows to 100px. A stale cache would keep 300.
    reads.clear();
    scrollerBox.mockClear();
    const narrower = { x: 0, y: 0, width: 100, height: 100 };
    scrollerBox.mockReturnValue(
      new DOMRect(narrower.x, narrower.y, narrower.width, narrower.height),
    );
    restubClient(scroller, narrower, NO_INSET);
    const versionBefore = result.current.version;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() =>
      expect(result.current.version).toBeGreaterThan(versionBefore),
    );

    expect(result.current.version).toBe(versionBefore + 1);
    expect(reads.get(scroller)).toBe(1);
    expect(scrollerBox).toHaveBeenCalledTimes(1);
    for (const [element, count] of reads)
      expect(count, element.tagName).toBeLessThanOrEqual(1);
    // chip-2 (60..84) is whole and stays. chip-3 (90..114) keeps 10px; its
    // 24px hit box (76..100) would cover chip-2, so it is unreachable now.
    // chip-4.. (120+) are clipped away entirely.
    expect(box(result.current.rects.get("chip-2"))).toEqual({
      x: 60,
      y: 10,
      width: 24,
      height: 24,
    });
    expect(result.current.unreachable.has("chip-3")).toBe(true);
    expect(result.current.unreachable.has("chip-7")).toBe(true);
    expectConsistent(result, keys);
  });

  it("rejects a hidden or disconnected hotspot before walking any of its ancestors", () => {
    const reads = spyStyleReads();
    const hiddenScroller = clipper(
      document.body,
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const hiddenWrapper = document.createElement("div");
    hiddenWrapper.hidden = true;
    hiddenScroller.appendChild(hiddenWrapper);
    const hiddenNode = nodeIn(hiddenWrapper, {
      x: 10,
      y: 10,
      width: 24,
      height: 24,
    });
    // A subtree that was never attached to the document.
    const detachedScroller = clipper(
      document.createElement("div"),
      { overflowX: "hidden", overflowY: "hidden" },
      { x: 0, y: 0, width: 100, height: 100 },
      NO_INSET,
    );
    const detachedNode = nodeIn(detachedScroller, {
      x: 10,
      y: 10,
      width: 24,
      height: 24,
    });
    const instances = new Map<string, HotspotInstance>([
      ["hidden", makeInstance("hidden", hiddenNode)],
      ["detached", makeInstance("detached", detachedNode)],
    ]);

    const { result } = renderHook(() => useHotspotRects(instances));

    expect(result.current.unreachable.has("hidden")).toBe(true);
    expect(result.current.unreachable.has("detached")).toBe(true);
    expect(result.current.hitRects.size).toBe(0);
    expect(reads.has(hiddenWrapper)).toBe(false);
    expect(reads.has(hiddenScroller)).toBe(false);
    expect(reads.has(detachedScroller)).toBe(false);
  });
});
