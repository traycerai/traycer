import { describe, expect, it } from "vitest";
import {
  PIERRE_ITEM_PATH_ATTR,
  extractPierreItemPathFromEvent,
  type PierreActivationEvent,
} from "@/components/epic-canvas/pierre-tree-adapter";

/**
 * Locks the `@pierre/trees` integration contract: we read the tree path
 * for a row out of the `data-item-path` attribute that Pierre stamps on
 * every row. Any Pierre upgrade that renames this attribute must update
 * the adapter here first, not the sidebar component.
 */
describe("pierre-tree-adapter", () => {
  it("uses the documented `data-item-path` attribute name", () => {
    expect(PIERRE_ITEM_PATH_ATTR).toBe("data-item-path");
  });

  it("walks the composed event path to find the nearest itemPath", () => {
    const row = document.createElement("button");
    row.setAttribute("data-item-path", "src/components/App.tsx");
    const child = document.createElement("span");
    row.appendChild(child);

    const event = makeEventWithComposedPath([child, row, document.body]);
    expect(extractPierreItemPathFromEvent(event)).toBe(
      "src/components/App.tsx",
    );
  });

  it("returns null when no element in the composed path has the attribute", () => {
    const target = document.createElement("div");
    const event = makeEventWithComposedPath([target, document.body]);
    expect(extractPierreItemPathFromEvent(event)).toBeNull();
  });

  it("skips non-HTMLElement targets (e.g. Document, ShadowRoot)", () => {
    const row = document.createElement("button");
    row.setAttribute("data-item-path", "package.json");
    const event = makeEventWithComposedPath([
      document,
      row,
      document.documentElement,
    ]);
    expect(extractPierreItemPathFromEvent(event)).toBe("package.json");
  });

  it("ignores empty itemPath values", () => {
    const row = document.createElement("button");
    row.setAttribute("data-item-path", "");
    const event = makeEventWithComposedPath([row]);
    expect(extractPierreItemPathFromEvent(event)).toBeNull();
  });
});

function makeEventWithComposedPath(
  path: ReadonlyArray<EventTarget>,
): PierreActivationEvent {
  return { nativeEvent: { composedPath: () => [...path] } };
}
