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
  "activeHeaderStripSession = null",
  "promotedPreviewOnDrag = null",
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
 * teardown. A top-level `useCallback` closes either inline (`"\n  }, ["`) or,
 * when prettier breaks the arguments, with the array alone on a line at four
 * spaces (`"\n    ["`); both say nothing about what is inside the brackets.
 */
function callbackBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `"${declaration}" not found`).toBeGreaterThan(-1);
  const end = source.slice(start).search(/\n {2}\}, \[|\n {4}\[/);
  expect(
    end,
    `no closing dependency array after "${declaration}"`,
  ).toBeGreaterThan(0);
  return source.slice(start, start + end);
}

/**
 * From a `{` at or after `fromIndex`, the balanced brace-delimited body
 * (including the braces themselves).
 *
 * Used for plain function declarations, which have no dependency array to
 * anchor on the way a `useCallback` does.
 */
function braceBody(source: string, fromIndex: number): string {
  const braceStart = source.indexOf("{", fromIndex);
  expect(braceStart, "no opening brace found").toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, "unbalanced braces").toBeGreaterThan(-1);
  return source.slice(braceStart, end + 1);
}

/** The body of a top-level `function` declaration, brace-matched. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `"${declaration}" not found`).toBeGreaterThan(-1);
  return braceBody(source, start);
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
    // The store reset too - a gesture that ends without it leaves the dnd
    // store publishing a dead drag into the next gesture.
    expect(body).toContain("dragEnded()");
  });

  it("no teardown assignment appears outside endGesture", () => {
    // This is the guard. Before the fix these statements were duplicated across
    // three blocks that had already drifted - one was written twice at two
    // indent levels - and two early returns performed a shortened subset.
    const source = providerSource();
    const body = endGestureBody(source);
    for (const assignment of TEARDOWN_ASSIGNMENTS) {
      const total = source.split(assignment).length - 1;
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
    // detach, composer attachment, main fall-through, cancel: four direct
    // calls. The reparent exit is the fifth, but it no longer calls
    // `endGesture()` inline - the try/catch/finally around the sidebar commit
    // moved into the module-local `commitReparentAndEndGesture` so React
    // Compiler can memoize this callback, and that finally now lives outside
    // this slice. It is verified structurally below instead of by count here.
    const directCalls = lifecycle.split("endGesture();").length - 1;
    expect(directCalls).toBe(4);

    // The reparent branch hands its OWN `endGesture` to the helper BY
    // REFERENCE rather than calling it: the bare name closing an argument
    // list (an optional trailing comma and any whitespace/reformatting
    // between the name and the closing paren) only ever appears at that
    // hand-off. It does not match "endGesture()" (a call - "(" immediately
    // follows the name, not whitespace/comma/")") or a dependency array's
    // "endGesture, hostBinding, ..." (more than one identifier before the
    // close) or "[endGesture]" (closes on "]", not ")").
    expect(lifecycle).toContain("commitReparentAndEndGesture(");
    const handoffs = (lifecycle.match(/endGesture\s*,?\s*\)/g) ?? []).length;
    expect(
      handoffs,
      "reparent exit should pass endGesture by reference to commitReparentAndEndGesture, not call it inline",
    ).toBe(1);

    // The helper must call that reference exactly once, unconditionally, from
    // a `finally` - the same guarantee the inline `finally` gave before the
    // extraction. A `finally` whose only statement is the call proves it runs
    // whether the sidebar commit resolves, rejects, or throws synchronously.
    const helperDeclaration = "function commitReparentAndEndGesture(";
    const helperStart = source.indexOf(helperDeclaration);
    expect(helperStart, `"${helperDeclaration}" not found`).toBeGreaterThan(-1);
    const helperBraceStart = source.indexOf("{", helperStart);
    // Params sit between the declaration and the body's opening brace, so the
    // signature check reads that header, not the body braceBody returns.
    const helperHeader = source.slice(helperStart, helperBraceStart);
    expect(helperHeader).toContain("endGesture: () => void");
    const helperBody = functionBody(source, helperDeclaration);
    const helperCalls = helperBody.split("endGesture();").length - 1;
    expect(
      helperCalls,
      "commitReparentAndEndGesture should call endGesture() exactly once",
    ).toBe(1);
    // Anchored on "} finally {" (the catch block's close immediately
    // followed by the keyword), not the bare word - a comment earlier in this
    // function's try block explains the finally in prose and would otherwise
    // match first.
    const finallyIndex = helperBody.indexOf("} finally {");
    expect(
      finallyIndex,
      "commitReparentAndEndGesture should end its gesture from a finally block",
    ).toBeGreaterThan(-1);
    const finallyBlock = braceBody(helperBody, finallyIndex);
    expect(finallyBlock.slice(1, -1).trim()).toBe("endGesture();");

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
