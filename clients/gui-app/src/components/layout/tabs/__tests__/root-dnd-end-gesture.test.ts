/** Under jsdom those measure as zero and stubbing the element's rect does not reach them, so a driven composer
 * drop never produces an `over` and the branch is unreachable from a test. */
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
  "promotedPreviewOnDrag = null",
] as const;

function providerSource(): string {
  return readFileSync(PROVIDER, "utf8");
}

/** Matching on `"}, [deps];"` would couple this guard to the exact dependency list, so adding one dependency to
 * an unrelated hook would break a test about teardown. */
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
    // Before the fix these statements were duplicated across three blocks that had already drifted - one was
    // written twice at two indent levels - and two early returns performed a shortened subset.
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
    // Ending the slice at handleDragCancel's dependency array rather than at a literal `"}, [endGesture]);"` keeps
    // this independent of that dependency list.
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

    // This asserts how many bare `return;` statements drag-end contains, which is not the same as proving each one
    // is preceded by teardown - checking that would need the source parsed, not split.
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
