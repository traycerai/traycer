import { afterEach, describe, expect, it } from "vitest";
import {
  captureScreenSnapshot,
  findSnapshotSource,
  SWIPE_NAV_EXCLUDE_ATTRIBUTE,
  SWIPE_NAV_SCREEN_ATTRIBUTE,
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

const WIDTH_PX = 400;

afterEach(() => {
  clearScreenSnapshots();
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
    const back = composeSwipeNavLayers("back", 0, WIDTH_PX, "pop");

    expect(back.nearLayer).toBe("outgoing");
    expect(swipeNavPlaneTransform(back, "near").x).toBe(0);
    expect(swipeNavPlaneTransform(back, "far").x).toBeLessThan(0);
    expect(swipeNavPlaneTransform(back, "far").dimOpacity).toBeGreaterThan(0);
  });

  it("arrives with both planes on the screen and the dim lifted", () => {
    const back = composeSwipeNavLayers("back", 1, WIDTH_PX, "pop");

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
    const rest = composeSwipeNavLayers("forward", 0, WIDTH_PX, "pop");
    const done = composeSwipeNavLayers("forward", 1, WIDTH_PX, "pop");

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
      const forward = composeSwipeNavLayers(
        "forward",
        progress,
        WIDTH_PX,
        "pop",
      );
      const back = composeSwipeNavLayers("back", 1 - progress, WIDTH_PX, "pop");

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
    const start = composeSwipeNavLayers("back", 0, WIDTH_PX, "pop");
    const end = composeSwipeNavLayers("back", 1, WIDTH_PX, "pop");
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
          "pop",
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

  // The cube turns the same two planes rather than sliding them, so nothing
  // translates and the hinge each face turns about is the edge they meet at.
  it("turns the planes about the edge they meet at, under the cube shape", () => {
    const rest = composeSwipeNavLayers("back", 0, WIDTH_PX, "cube");
    const done = composeSwipeNavLayers("back", 1, WIDTH_PX, "cube");

    expect(swipeNavPlaneTransform(rest, "near").x).toBe(0);
    expect(swipeNavPlaneTransform(rest, "near").rotateY).toBe(0);
    expect(swipeNavPlaneTransform(rest, "far").rotateY).toBe(-90);
    expect(swipeNavPlaneTransform(done, "near").rotateY).toBe(90);
    // A signed zero: the face has finished turning, from the negative side.
    expect(swipeNavPlaneTransform(done, "far").rotateY).toBeCloseTo(0);
    expect(swipeNavPlaneTransform(rest, "near").transformOrigin).not.toBe(
      swipeNavPlaneTransform(rest, "far").transformOrigin,
    );
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
  function snapshotOf(text: string) {
    const node = document.createElement("div");
    node.textContent = text;
    return { node };
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

  // Scroll offsets and canvas pixels are the other half of a faithful copy and
  // are deliberately NOT asserted here: jsdom lays nothing out, so it reports
  // every scroll offset as 0 and gives a canvas no drawing context. A test
  // written against it would pass by agreeing with a stub rather than by
  // observing the behaviour, which is worse than no test. Both are verified on
  // a device, where a chat read halfway down and a live terminal are the cases
  // that show it.
});
