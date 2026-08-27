/**
 * Regression guard for the gesture-teardown bug.
 *
 * Two early returns in `handleDragEnd` - the sidebar reparent commit and the
 * composer attachment drop - performed only PART of the teardown every other
 * exit performed. Both are ordinary supported gestures
 * (`composer-attachment-drop-zone` accepts any source
 * `mentionAttachmentFromDragSource` resolves, and that handles
 * `ARTIFACT_TAB_DND_TYPE`), and both left module-scoped state alive into the
 * NEXT drag:
 *
 *   `activeTileDrag`         `rootDragOverlayModifier` tests it BEFORE deciding
 *                            the drag kind, so the next drag of ANY kind is
 *                            positioned with the dead tile's grab offset.
 *   `promotedPreviewOnDrag`  a later Esc runs `restorePreviewInTab` against a
 *                            stale tile, re-marking an unrelated promoted tile
 *                            as a preview - the residual the promote/restore
 *                            pair exists to prevent, inverted.
 *
 * WHY THIS IS A SOURCE-SHAPE TEST AND NOT A DRIVEN GESTURE. Reaching either
 * early return requires dnd-kit to resolve `event.over` to the relevant
 * droppable, and `epicRootCollisionDetection` gates on `pointerWithin`, which
 * reads dnd-kit's OWN measured `droppableRects` rather than live
 * `getBoundingClientRect()`. Under jsdom those measure as zero and stubbing the
 * element's rect does not reach them, so a driven composer drop never produces
 * an `over` and the branch is unreachable from a test. A driven test that could
 * not enter the branch would pass without exercising anything - which is the
 * failure mode this project spent five sprints refusing.
 *
 * So this asserts the STRUCTURAL property the fix establishes instead: teardown
 * exists in exactly one place and every exit routes through it. That is checkable,
 * it fails loudly if someone re-adds a partial teardown, and it is the same
 * source-shape guard style as `muted-fill-on-raised-surface-lint.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROVIDER = join(
  process.cwd(),
  "src/components/epic-canvas/dnd/root-dnd-provider.tsx",
);

/** State a finished gesture must not leave behind. */
const TEARDOWN_ASSIGNMENTS = [
  "activeTileDrag = null",
  "activeHeaderStripGeometry = null",
  "lastHeaderDrag = null",
  "promotedPreviewOnDrag = null",
  "replayCanvasPreview = null",
] as const;

function providerSource(): string {
  return readFileSync(PROVIDER, "utf8");
}

/**
 * Slice a `useCallback` body from its declaration to the start of its dependency
 * array.
 *
 * Matching on `"}, [deps];"` would couple this guard to the exact dependency
 * list, so adding one dependency to an unrelated hook would break a test about
 * teardown. `"\n  }, ["` is the closing line of a top-level `useCallback` at
 * this file's indentation and says nothing about what is inside the brackets.
 */
function callbackBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `"${declaration}" not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }, [", start);
  expect(
    end,
    `no closing dependency array after "${declaration}"`,
  ).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The body of `endGesture`, from its declaration to its dependency array. */
function endGestureBody(source: string): string {
  return callbackBody(source, "const endGesture = useCallback(");
}

describe("gesture teardown is centralised", () => {
  it("endGesture clears every piece of cross-gesture state", () => {
    const body = endGestureBody(providerSource());
    for (const assignment of TEARDOWN_ASSIGNMENTS) {
      expect(body).toContain(assignment);
    }
    // The dwell latches and the store all reset here too - a gesture that ends
    // without these leaves a latch armed for the next one.
    expect(body).toContain("paneBodyDwell().reset()");
    expect(body).toContain("edgeDwell.reset()");
    expect(body).toContain("clearMergeDwellTimer()");
    expect(body).toContain("dragEnded()");
  });

  it("no teardown assignment appears outside endGesture", () => {
    // This is the guard. Before the fix these statements were duplicated across
    // three blocks that had already drifted - one was written twice at two
    // indent levels - and two early returns performed a shortened subset.
    const source = providerSource();
    const body = endGestureBody(source);
    // `replayCanvasPreview` has one legitimate second site: the provider's
    // UNMOUNT effect, which is not a gesture end. Excluding the unmount effect
    // by slice keeps the guard exact rather than relaxing it to "at most two".
    const unmountEffectStart = source.indexOf(
      "  // The dwell timer re-runs the preview with the last event",
    );
    expect(unmountEffectStart).toBeGreaterThan(-1);
    const unmountEffectEnd = source.indexOf("}, []);", unmountEffectStart);
    expect(
      unmountEffectEnd,
      "unmount effect has no closing `}, []);`",
    ).toBeGreaterThan(unmountEffectStart);
    const withoutUnmount =
      source.slice(0, unmountEffectStart) + source.slice(unmountEffectEnd);

    for (const assignment of TEARDOWN_ASSIGNMENTS) {
      const total = withoutUnmount.split(assignment).length - 1;
      const inside = body.split(assignment).length - 1;
      expect(
        total,
        `"${assignment}" should be assigned only inside endGesture`,
      ).toBe(inside);
    }
  });

  it("every drag-end exit and the cancel path call endGesture", () => {
    const source = providerSource();
    const dragEndStart = source.indexOf("const handleDragEnd = useCallback(");
    expect(dragEndStart).toBeGreaterThan(-1);
    // Both callbacks together: drag-end's four exits plus cancel's one. Ending
    // the slice at handleDragCancel's dependency array rather than at a literal
    // `"}, [endGesture]);"` keeps this independent of that dependency list.
    const cancelBody = callbackBody(
      source,
      "const handleDragCancel = useCallback(",
    );
    const cancelStart = source.indexOf(cancelBody);
    const lifecycle = source.slice(
      dragEndStart,
      cancelStart + cancelBody.length,
    );
    // detach, reparent, composer attachment, main fall-through, cancel.
    const calls = lifecycle.split("endGesture();").length - 1;
    expect(calls).toBe(5);

    // COUNT, not adjacency. This asserts how many bare `return;` statements
    // drag-end contains, which is not the same as proving each one is preceded
    // by teardown - checking that would need the source parsed, not split. It
    // still does the job it is here for: the fix left exactly three, so ADDING
    // an early return turns this red and forces whoever added it to look at
    // whether their exit calls `endGesture()`. Update the number only together
    // with the `endGesture();` count above.
    const dragEndBody = source.slice(
      dragEndStart,
      source.indexOf("const handleDragCancel", dragEndStart),
    );
    const returns = dragEndBody
      .split("\n")
      .filter((line) => line.trim() === "return;");
    expect(returns.length).toBe(3);
  });
});
