import { describe, expect, it } from "vitest";
import { createSeparator } from "@pierre/diffs";
import type { Element, ElementContent } from "hast";

/**
 * The separator our `@pierre/diffs` patch gives an expanded context region
 * (`patches/@pierre%2Fdiffs@1.3.1.patch`), built by the real, patched
 * `createSeparator`.
 *
 * A region expanded only part way offers both halves: a collapse control and
 * an expander for the lines still hidden. A region expanded in full is
 * "collapse only" and offers nothing to expand - no expander and no
 * "Expand all" - while keeping `data-expand-index`, which is how a click on
 * its collapse control finds the region. `browser-tests/diff-edit.spec.ts`
 * checks the unchunked case on a painted diff; a chunked region (one larger
 * than a single expand) is only reachable here.
 */

// The patch adds `collapsible` and `collapseOnly` to `createSeparator`'s
// props; the package's own declaration file predates them.
interface PatchedSeparatorProps {
  readonly type: "line-info";
  readonly content: string;
  readonly expandIndex: number;
  readonly chunked: boolean;
  readonly isFirstHunk: boolean;
  readonly isLastHunk: boolean;
  readonly collapsible: boolean;
  readonly collapseOnly: boolean;
}

function separator(
  chunked: boolean,
  collapseOnly: boolean,
): { readonly root: Element; readonly elements: readonly Element[] } {
  const props: PatchedSeparatorProps = {
    type: "line-info",
    content: collapseOnly ? "Collapse expanded lines" : "120 unmodified lines",
    expandIndex: 1,
    chunked,
    isFirstHunk: false,
    isLastHunk: false,
    collapsible: true,
    collapseOnly,
  };
  const root = createSeparator(props);
  const elements: Element[] = [];
  const visit = (node: ElementContent): void => {
    if (node.type !== "element") return;
    elements.push(node);
    node.children.forEach(visit);
  };
  root.children.forEach(visit);
  return { root, elements };
}

function has(element: Element, attribute: string): boolean {
  return element.properties[attribute] !== undefined;
}

function expanders(elements: readonly Element[]): readonly Element[] {
  return elements.filter(
    (element) =>
      has(element, "data-expand-button") &&
      !has(element, "data-collapse-button"),
  );
}

function collapseButtons(elements: readonly Element[]): readonly Element[] {
  return elements.filter(
    (element) =>
      element.tagName === "button" && has(element, "data-collapse-button"),
  );
}

describe("patched @pierre/diffs separator for an expanded region", () => {
  for (const chunked of [false, true]) {
    const kind = chunked ? "a chunked" : "an unchunked";

    it(`offers only its collapse control once ${kind} region is fully expanded`, () => {
      const { root, elements } = separator(chunked, true);

      expect(collapseButtons(elements)).toHaveLength(1);
      expect(expanders(elements)).toEqual([]);
      expect(root.properties["data-expand-index"]).toBe(1);
    });

    it(`offers its collapse control and an expander while ${kind} region is partly expanded`, () => {
      const { root, elements } = separator(chunked, false);

      expect(collapseButtons(elements)).toHaveLength(1);
      expect(expanders(elements).length).toBeGreaterThan(0);
      expect(root.properties["data-expand-index"]).toBe(1);
    });
  }
});
