import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  applyScreenSnapshotScroll,
  captureScreenSnapshot,
  findSnapshotSource,
  SWIPE_NAV_EXCLUDE_ATTRIBUTE,
  SWIPE_NAV_SCREEN_ATTRIBUTE,
  type ScreenSnapshot,
} from "@/components/layout/shell/screen-snapshot";
import {
  clearScreenSnapshots,
  readHistoryEntryKey,
  readScreenSnapshot,
  rememberScreenSnapshot,
} from "@/components/layout/shell/screen-snapshot-cache";
import {
  composeSwipeNavLayers,
  swipeNavCommits,
  swipeNavPlaneTransform,
} from "@/components/layout/shell/swipe-nav-transition-motion";
import {
  useSwipeNavTransition,
  type SwipeNavRouter,
} from "@/components/layout/shell/use-swipe-nav-transition";
import { __resetDocumentVisibilitySubscribersForTests } from "@/lib/dom/document-visibility";
import { setMobileApp } from "@/lib/mobile-app";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

const WIDTH_PX = 400;

afterEach(() => {
  clearScreenSnapshots();
  setRetentionProfile(DESKTOP_RETENTION_PROFILE);
  setMobileApp(false);
  document.body.innerHTML = "";
});

/**
 * The geometry both directions are derived from. The cases are written against
 * the PLANES rather than the screens, because that is the invariant: whichever
 * screen the finger is carrying is the near one, and it behaves identically
 * going back and going forward.
 */
describe("composeSwipeNavLayers", () => {
  it("rests with the near plane covering the screen and the far one behind it", () => {
    const back = composeSwipeNavLayers("back", 0, WIDTH_PX);

    expect(back.nearLayer).toBe("outgoing");
    expect(swipeNavPlaneTransform(back, "near").x).toBe(0);
    expect(swipeNavPlaneTransform(back, "far").x).toBeLessThan(0);
    expect(swipeNavPlaneTransform(back, "far").dimOpacity).toBeGreaterThan(0);
  });

  it("arrives with both planes on the screen and the dim lifted", () => {
    const back = composeSwipeNavLayers("back", 1, WIDTH_PX);

    expect(swipeNavPlaneTransform(back, "near").x).toBe(WIDTH_PX);
    // Signed zeroes: both quantities arrive from the negative side.
    expect(swipeNavPlaneTransform(back, "far").x).toBeCloseTo(0);
    expect(swipeNavPlaneTransform(back, "far").dimOpacity).toBeCloseTo(0);
  });

  // A forward swipe carries the DESTINATION in from the trailing edge - the
  // edge the finger entered at - while the outgoing screen recedes toward the
  // leading one. Asserted against the EDGES rather than against back's values
  // negated: forward is back run in reverse, not back's mirror image, and a
  // mirrored assertion once certified a forward whose planes travelled against
  // the finger.
  it("carries the destination in from the trailing edge, going forward", () => {
    const rest = composeSwipeNavLayers("forward", 0, WIDTH_PX);
    const done = composeSwipeNavLayers("forward", 1, WIDTH_PX);

    expect(rest.nearLayer).toBe("destination");
    expect(swipeNavPlaneTransform(rest, "near").x).toBe(WIDTH_PX);
    expect(swipeNavPlaneTransform(rest, "far").x).toBeCloseTo(0);
    expect(swipeNavPlaneTransform(done, "near").x).toBe(0);
    expect(swipeNavPlaneTransform(done, "far").x).toBeLessThan(0);
    expect(swipeNavPlaneTransform(done, "far").dimOpacity).toBeGreaterThan(0);
  });

  // The stack itself does not know which way the gesture runs: forward at any
  // progress occupies exactly the positions back occupies at the complementary
  // one. This is the invariant that keeps the two directions one code path.
  it("runs forward as back played in reverse, plane for plane", () => {
    for (let step = 0; step <= 10; step += 1) {
      const progress = step / 10;
      const forward = composeSwipeNavLayers("forward", progress, WIDTH_PX);
      const back = composeSwipeNavLayers("back", 1 - progress, WIDTH_PX);

      for (const plane of ["near", "far"] as const) {
        expect(swipeNavPlaneTransform(forward, plane).x).toBeCloseTo(
          swipeNavPlaneTransform(back, plane).x,
        );
        expect(swipeNavPlaneTransform(forward, plane).dimOpacity).toBeCloseTo(
          swipeNavPlaneTransform(back, plane).dimOpacity,
        );
      }
    }
  });

  // The depth cue is the DIFFERENCE in speed. If the far plane travelled as far
  // as the near one the pair would read as one strip of content sliding past a
  // window rather than as two stacked screens.
  it("moves the far plane a fraction of what the near one moves", () => {
    // Both travels are MEASURED between the endpoints rather than derived from
    // the parallax constant: a test that recomputes the formula it is checking
    // agrees with any formula, including none at all.
    const start = composeSwipeNavLayers("back", 0, WIDTH_PX);
    const end = composeSwipeNavLayers("back", 1, WIDTH_PX);
    const nearTravel = Math.abs(
      swipeNavPlaneTransform(end, "near").x -
        swipeNavPlaneTransform(start, "near").x,
    );
    const farTravel = Math.abs(
      swipeNavPlaneTransform(end, "far").x -
        swipeNavPlaneTransform(start, "far").x,
    );

    expect(nearTravel).toBe(WIDTH_PX);
    expect(farTravel).toBeGreaterThan(0);
    expect(farTravel).toBeLessThan(nearTravel);
  });

  it("never leaves a gap between the planes at any point of the travel", () => {
    for (const direction of ["back", "forward"] as const) {
      for (let step = 0; step <= 10; step += 1) {
        const composition = composeSwipeNavLayers(
          direction,
          step / 10,
          WIDTH_PX,
        );
        const near = swipeNavPlaneTransform(composition, "near").x;
        const far = swipeNavPlaneTransform(composition, "far").x;
        const leading = Math.min(near, far);
        const trailing = Math.max(near, far);
        // Each plane spans a full width from its own offset. The screen is
        // covered when the pair reaches both edges AND the trailing plane
        // starts before the leading one ends - the third condition is the one
        // that matters, since a gap between them would show the live app the
        // gesture has not navigated yet.
        expect(leading).toBeLessThanOrEqual(0);
        expect(trailing + WIDTH_PX).toBeGreaterThanOrEqual(WIDTH_PX);
        expect(trailing).toBeLessThanOrEqual(leading + WIDTH_PX);
      }
    }
  });
});

describe("swipeNavCommits", () => {
  it("commits a flick that has barely travelled", () => {
    expect(
      swipeNavCommits({
        travelPx: 20,
        widthPx: WIDTH_PX,
        velocityPxPerS: 900,
        cancelled: false,
      }),
    ).toBe(true);
  });

  it("springs back a slow drag that did not reach the threshold", () => {
    expect(
      swipeNavCommits({
        travelPx: 60,
        widthPx: WIDTH_PX,
        velocityPxPerS: 10,
        cancelled: false,
      }),
    ).toBe(false);
  });

  it("commits a slow drag that did", () => {
    expect(
      swipeNavCommits({
        travelPx: 200,
        widthPx: WIDTH_PX,
        velocityPxPerS: 10,
        cancelled: false,
      }),
    ).toBe(true);
  });

  // A gesture the system took away expressed no intent, however far it had
  // travelled when it was interrupted.
  it("springs back a cancelled drag that had already crossed the threshold", () => {
    expect(
      swipeNavCommits({
        travelPx: 380,
        widthPx: WIDTH_PX,
        velocityPxPerS: 900,
        cancelled: true,
      }),
    ).toBe(false);
  });
});

describe("readHistoryEntryKey", () => {
  it("reads the key the router stamped", () => {
    expect(readHistoryEntryKey({ state: { __TSR_key: "abc123" } })).toBe(
      "abc123",
    );
  });

  it("answers null for an entry the router did not stamp", () => {
    expect(readHistoryEntryKey({ state: {} })).toBeNull();
    expect(readHistoryEntryKey({ state: null })).toBeNull();
    expect(readHistoryEntryKey({ state: { __TSR_key: 4 } })).toBeNull();
  });
});

describe("the snapshot cache", () => {
  function snapshotOf(text: string): ScreenSnapshot {
    const node = document.createElement("div");
    node.textContent = text;
    // The cache stores screens and never reads inside them, so an unscrolled
    // one is all these cases need.
    return { node, scrollOffsets: [] };
  }

  it("files a screen under the entry it shows", () => {
    rememberScreenSnapshot("entry-five", snapshotOf("five"));

    expect(readScreenSnapshot("entry-five")?.node.textContent).toBe("five");
    expect(readScreenSnapshot("entry-four")).toBeNull();
  });

  // A run of consecutive back swipes walks the cursor across entries that were
  // all two-or-more steps away when they were filed. Retention by recency is
  // what keeps the SECOND back of a run animated: pruning against the arrival
  // position released exactly the screen that back needed.
  it("keeps the screens a run of consecutive swipes walks back across", () => {
    rememberScreenSnapshot("entry-a", snapshotOf("first"));
    rememberScreenSnapshot("entry-b", snapshotOf("second"));

    expect(readScreenSnapshot("entry-b")?.node.textContent).toBe("second");
    expect(readScreenSnapshot("entry-a")?.node.textContent).toBe("first");
  });

  // A frozen screen is a whole DOM tree held out of the collector's reach, so
  // the cache is bounded - by count, since distance from the cursor is not a
  // bound the cursor's own movement respects.
  it("releases the least recently filed screen once full", () => {
    for (let step = 0; step <= 4; step += 1) {
      rememberScreenSnapshot(`entry-${step}`, snapshotOf(`screen ${step}`));
    }

    expect(readScreenSnapshot("entry-0")).toBeNull();
    expect(readScreenSnapshot("entry-1")?.node.textContent).toBe("screen 1");
    expect(readScreenSnapshot("entry-4")?.node.textContent).toBe("screen 4");
  });

  // Re-filing an entry is a fresh departure from it - the strongest claim on
  // being swiped back to - so it renews the screen's tenure rather than
  // inheriting the original filing's.
  it("renews a screen's tenure when its entry is filed again", () => {
    for (let step = 0; step <= 3; step += 1) {
      rememberScreenSnapshot(`entry-${step}`, snapshotOf(`screen ${step}`));
    }
    rememberScreenSnapshot("entry-0", snapshotOf("zero refiled"));
    rememberScreenSnapshot("entry-4", snapshotOf("screen 4"));

    expect(readScreenSnapshot("entry-1")).toBeNull();
    expect(readScreenSnapshot("entry-0")?.node.textContent).toBe(
      "zero refiled",
    );
    expect(readScreenSnapshot("entry-4")?.node.textContent).toBe("screen 4");
  });
});

/**
 * The phone's cap, which is ONE - and the cases that matter are the ones that
 * still work at one, not the count itself. A depth of N animates a run of
 * N - 1 steps, because every commit files the screen it just left, so two is
 * worth exactly what one is and one is the floor.
 */
describe("the snapshot cache on the phone", () => {
  function snapshotOf(text: string): ScreenSnapshot {
    const node = document.createElement("div");
    node.textContent = text;
    return { node, scrollOffsets: [] };
  }

  it("holds one frozen screen, and releases the one it was holding", () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);

    rememberScreenSnapshot("entry-a", snapshotOf("first"));
    rememberScreenSnapshot("entry-b", snapshotOf("second"));

    expect(readScreenSnapshot("entry-b")?.node.textContent).toBe("second");
    expect(readScreenSnapshot("entry-a")).toBeNull();
  });

  // The walk the whole cap is chosen for. Every navigation files the screen it
  // leaves, so the entry a back swipe is heading to is always the newest thing
  // in the cache - and after that swipe commits, the screen it CAME from is,
  // which is what the forward swipe undoing it asks for. One slot sustains the
  // pair indefinitely; the deeper cache only ever bought the second step of a
  // run in one direction.
  it("has the previous screen for a back swipe, and for the forward that undoes it", () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    // A -> B -> C: each departure files the screen being left.
    rememberScreenSnapshot("entry-a", snapshotOf("screen a"));
    rememberScreenSnapshot("entry-b", snapshotOf("screen b"));

    // At C, a back swipe asks for B and animates.
    expect(readScreenSnapshot("entry-b")?.node.textContent).toBe("screen b");
    // Its commit leaves C, filing the drag's own outgoing copy.
    rememberScreenSnapshot("entry-c", snapshotOf("screen c"));

    // At B, the forward swipe that undoes it asks for C and animates.
    expect(readScreenSnapshot("entry-c")?.node.textContent).toBe("screen c");
    rememberScreenSnapshot("entry-b", snapshotOf("screen b again"));

    // And back again, for as long as the user keeps changing their mind.
    expect(readScreenSnapshot("entry-b")?.node.textContent).toBe(
      "screen b again",
    );
  });

  // The second back of a run is the one a cap of one gives up, and giving it
  // up is a documented fallback rather than a break: no frozen destination
  // means the gesture performs the instant navigation it always did.
  it("answers null for the step beyond the one it holds", () => {
    setRetentionProfile(MOBILE_RETENTION_PROFILE);
    rememberScreenSnapshot("entry-a", snapshotOf("screen a"));
    rememberScreenSnapshot("entry-b", snapshotOf("screen b"));
    rememberScreenSnapshot("entry-c", snapshotOf("screen c"));

    expect(readScreenSnapshot("entry-c")).not.toBeNull();
    expect(readScreenSnapshot("entry-b")).toBeNull();
    expect(readScreenSnapshot("entry-a")).toBeNull();
  });
});

/**
 * The reclaim at the background edge. A frozen screen is a bet on a gesture
 * about to happen, and a suspended app is one where none can be - which is
 * also the only moment iOS measures the process it is deciding whether to
 * kill.
 */
describe("frozen screens while the app is off screen", () => {
  function screenWithCanvas(): ScreenSnapshot {
    const node = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 480;
    node.appendChild(canvas);
    return { node, scrollOffsets: [] };
  }

  function mountTransition(): { readonly unmount: () => void } {
    const router: SwipeNavRouter = {
      history: createMemoryHistory({ initialEntries: ["/"] }),
      // The filling side is driven directly by these cases; what is under test
      // is the hook's own reclaim, not the departure subscription.
      subscribe: () => () => undefined,
    };
    return renderHook(() =>
      useSwipeNavTransition(
        router,
        () => undefined,
        () => null,
      ),
    );
  }

  function reportVisibility(state: "hidden" | "visible"): void {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  afterEach(() => {
    // Hands `visibilityState` back to the prototype's own answer.
    Reflect.deleteProperty(document, "visibilityState");
    __resetDocumentVisibilitySubscribersForTests();
  });

  it("drops every held screen when the app goes off screen", () => {
    setMobileApp(true);
    rememberScreenSnapshot("entry-a", screenWithCanvas());
    const { unmount } = mountTransition();

    reportVisibility("hidden");

    expect(readScreenSnapshot("entry-a")).toBeNull();
    unmount();
  });

  // Dropping the reference is not enough at this edge: the process is measured
  // while it is suspended, so nothing collects the pixel buffers before iOS
  // reads the number it kills on.
  it("gives up the canvas pixels rather than waiting for a collection", () => {
    setMobileApp(true);
    const screen = screenWithCanvas();
    rememberScreenSnapshot("entry-a", screen);
    const { unmount } = mountTransition();

    reportVisibility("hidden");

    const canvas = screen.node.querySelector("canvas");
    expect(canvas?.width).toBe(0);
    expect(canvas?.height).toBe(0);
    unmount();
  });

  it("leaves the held screen alone while the app is on screen", () => {
    setMobileApp(true);
    rememberScreenSnapshot("entry-a", screenWithCanvas());
    const { unmount } = mountTransition();

    reportVisibility("visible");

    expect(readScreenSnapshot("entry-a")).not.toBeNull();
    unmount();
  });
});

describe("captureScreenSnapshot", () => {
  function mountScreen(inner: string): HTMLElement {
    document.body.innerHTML = `<div ${SWIPE_NAV_SCREEN_ATTRIBUTE}>${inner}</div>`;
    const source = findSnapshotSource();
    if (source === null) throw new Error("screen did not mount");
    return source;
  }

  it("copies the screen as it is painted", () => {
    const source = mountScreen(`<p id="body">a chat</p>`);

    const snapshot = captureScreenSnapshot(source);

    expect(snapshot?.node.textContent).toBe("a chat");
  });

  // A frozen screen sits on top of the live app it was copied from. Left
  // interactive it would answer hit tests and be read out, so the app would
  // have two of everything for the length of a gesture.
  it("freezes the copy out of reach of pointers and assistive technology", () => {
    const snapshot = captureScreenSnapshot(mountScreen("<p>a chat</p>"));

    expect(snapshot?.node.getAttribute("aria-hidden")).toBe("true");
    expect(snapshot?.node.hasAttribute("inert")).toBe(true);
    expect(snapshot?.node.style.pointerEvents).toBe("none");
  });

  // Without this a snapshot taken while a transition is on screen clones the
  // frozen screens into the next frozen screen, and the one after contains
  // both.
  it("leaves out the subtrees marked as never belonging to a copy", () => {
    const source = mountScreen(
      `<p>a chat</p><div ${SWIPE_NAV_EXCLUDE_ATTRIBUTE}><p>frozen</p></div>`,
    );

    const snapshot = captureScreenSnapshot(source);

    expect(snapshot?.node.textContent).toBe("a chat");
  });

  /**
   * Scroll offsets are RECORDED at capture and applied after the node is
   * mounted, and it is the recording these assert.
   *
   * That split is the fix for a real defect and not a convenience: a detached
   * element has no scroll box, so writing `scrollTop` to the clone at capture
   * time was silently discarded and every scrollable region froze at its top.
   * Recording is also the half a layout-free environment can observe - the
   * numbers are read from the source and carried as data, so nothing here
   * depends on jsdom laying anything out.
   *
   * What these do NOT cover, and what still needs a device: that APPLYING them
   * after mount actually moves the region (jsdom reports every offset as 0
   * however it is set), and canvas restoration (jsdom gives a canvas no
   * drawing context). A chat read halfway down and a live terminal tile are
   * the two cases that show those.
   */
  it("records where each scrolled region was, against the cloned element", () => {
    const source = mountScreen(`<div id="list"><p>a chat</p></div>`);
    const list = source.querySelector("#list");
    if (!(list instanceof HTMLElement)) throw new Error("list did not mount");
    Object.defineProperty(list, "scrollTop", {
      value: 250,
      configurable: true,
    });
    Object.defineProperty(list, "scrollLeft", {
      value: 10,
      configurable: true,
    });

    const snapshot = captureScreenSnapshot(source);
    const recorded = snapshot?.scrollOffsets ?? [];

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scrollTop).toBe(250);
    expect(recorded[0]?.scrollLeft).toBe(10);
    // The CLONE's element, never the live one: applying to the source would
    // scroll the screen the user is still looking at.
    expect(recorded[0]?.element).toBe(snapshot?.node.querySelector("#list"));
    expect(recorded[0]?.element).not.toBe(list);
  });

  // The screen ROOT is as capable of scrolling as anything inside it, and a
  // descendant-only walk skips exactly the region the marker names - which
  // would freeze it at its top, the defect this recording exists to prevent.
  it("records the screen root's own offset, against the clone root", () => {
    const source = mountScreen(`<p>a chat</p>`);
    Object.defineProperty(source, "scrollTop", {
      value: 120,
      configurable: true,
    });

    const snapshot = captureScreenSnapshot(source);
    const recorded = snapshot?.scrollOffsets ?? [];

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scrollTop).toBe(120);
    expect(recorded[0]?.element).toBe(snapshot?.node);
    expect(recorded[0]?.element).not.toBe(source);
  });

  // A region at its origin is not worth carrying: every element in the tree
  // would otherwise be recorded, and a frozen screen is already a whole DOM
  // tree held out of the collector's reach.
  it("records nothing for a screen that is not scrolled anywhere", () => {
    const snapshot = captureScreenSnapshot(
      mountScreen(`<div id="list"><p>a chat</p></div>`),
    );

    expect(snapshot?.scrollOffsets).toHaveLength(0);
  });

  // The write is deferred, not skipped. `applyScreenSnapshotScroll` is what
  // the mount calls, and it must assign to the recorded element rather than
  // re-deriving anything.
  it("applies a recorded offset to the element it was recorded against", () => {
    const source = mountScreen(`<div id="list"><p>a chat</p></div>`);
    const list = source.querySelector("#list");
    if (!(list instanceof HTMLElement)) throw new Error("list did not mount");
    Object.defineProperty(list, "scrollTop", {
      value: 250,
      configurable: true,
    });
    const snapshot = captureScreenSnapshot(source);
    if (snapshot === null) throw new Error("snapshot did not capture");
    const applied: Array<{ top: number; left: number }> = [];
    expect(snapshot.scrollOffsets).toHaveLength(1);
    const target = snapshot.scrollOffsets[0].element;
    Object.defineProperty(target, "scrollTop", {
      set: (value: number) => applied.push({ top: value, left: 0 }),
      get: () => 0,
      configurable: true,
    });

    applyScreenSnapshotScroll(snapshot);

    expect(applied).toEqual([{ top: 250, left: 0 }]);
  });
});
