import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animate, useMotionValue } from "motion/react";
import {
  armTileStripCommitHandoff,
  disarmTileStripCommitHandoff,
  registerTileStripItem,
  runTileStripCommitHandoff,
  syncTileStripItem,
} from "@/components/epic-canvas/dnd/tile-strip-commit-handoff";

/**
 * `runTileStripCommitHandoff` runs unconditionally in `TabStrip`'s layout
 * effect, on every render. The fix moves the baseline read into
 * `armTileStripCommitHandoff`, so an unarmed commit reads zero offsets.
 */
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, animate: vi.fn(actual.animate) };
});

const GROUP_ID = "group-a";

function makeTrackedNode(): {
  readonly node: HTMLElement;
  setOffsetLeft(value: number): void;
  readonly reads: { count: number };
} {
  const groupEl = document.createElement("div");
  groupEl.setAttribute("data-group-id", GROUP_ID);
  const node = document.createElement("div");
  groupEl.appendChild(node);
  document.body.appendChild(groupEl);
  const reads = { count: 0 };
  let current = 0;
  Object.defineProperty(node, "offsetLeft", {
    configurable: true,
    get() {
      reads.count += 1;
      return current;
    },
  });
  return {
    node,
    setOffsetLeft: (value: number) => {
      current = value;
    },
    reads,
  };
}

afterEach(() => {
  disarmTileStripCommitHandoff();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("runTileStripCommitHandoff - unarmed commit", () => {
  it("reads zero offsets and never jumps or animates when the group was never armed", () => {
    const { result, unmount } = renderHook(() => useMotionValue(100));
    const x = result.current;
    const unregister = registerTileStripItem(x);
    const tracked = makeTrackedNode();
    syncTileStripItem({
      value: x,
      node: tracked.node,
      targetX: 100,
      transition: { duration: 0 },
    });
    tracked.reads.count = 0;

    runTileStripCommitHandoff(GROUP_ID);

    expect(tracked.reads.count).toBe(0);
    expect(x.get()).toBe(100);
    expect(animate).not.toHaveBeenCalled();

    unregister();
    unmount();
  });
});

describe("runTileStripCommitHandoff - armed commit consumes the arm-time baseline", () => {
  it("computes the FLIP delta from the offset captured at arm time against the post-reorder offset", () => {
    const { result, unmount } = renderHook(() => useMotionValue(100));
    const x = result.current;
    const unregister = registerTileStripItem(x);
    const tracked = makeTrackedNode();
    tracked.setOffsetLeft(50);
    syncTileStripItem({
      value: x,
      node: tracked.node,
      targetX: 100,
      transition: { duration: 0 },
    });

    // Arm immediately before the drop commits: captures the pre-reorder DOM
    // offset (50) as the baseline, reading it exactly once.
    armTileStripCommitHandoff(GROUP_ID);

    // The reorder moves the item in the DOM; only its `offsetLeft` changes.
    tracked.setOffsetLeft(90);
    tracked.reads.count = 0;

    runTileStripCommitHandoff(GROUP_ID);

    // FLIP invert: baseline (50) + pre-jump visual offset (100) - new DOM
    // offset (90) = 60, keeping the item painted where it visually was.
    expect(x.get()).toBe(60);
    expect(tracked.reads.count).toBe(1);
    expect(animate).toHaveBeenCalledWith(x, 100, { duration: 0 });

    unregister();
    unmount();
  });

  it("consumes the arm exactly once - a second commit for the same group is unarmed and reads nothing", () => {
    const { result, unmount } = renderHook(() => useMotionValue(100));
    const x = result.current;
    const unregister = registerTileStripItem(x);
    const tracked = makeTrackedNode();
    tracked.setOffsetLeft(50);
    syncTileStripItem({
      value: x,
      node: tracked.node,
      targetX: 100,
      transition: { duration: 0 },
    });

    armTileStripCommitHandoff(GROUP_ID);
    tracked.setOffsetLeft(90);
    runTileStripCommitHandoff(GROUP_ID);
    vi.mocked(animate).mockClear();
    tracked.reads.count = 0;

    // No re-arm before this second commit - an ordinary follow-up render.
    runTileStripCommitHandoff(GROUP_ID);

    expect(tracked.reads.count).toBe(0);
    expect(animate).not.toHaveBeenCalled();

    unregister();
    unmount();
  });
});
