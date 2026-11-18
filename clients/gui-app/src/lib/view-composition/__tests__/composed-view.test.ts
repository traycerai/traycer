import { describe, expect, it } from "vitest";
import { HISTORY_COMPOSED_VIEW } from "@/lib/history-composition/compose-history-page";
import {
  defineComposedView,
  intersectRole,
} from "@/lib/view-composition/composed-view";

describe("defineComposedView", () => {
  it("accepts the History view's registered contributors", () => {
    const view = defineComposedView("history", [
      { id: "pool-page", kind: "unary", method: "epic.listTasks" },
      { id: "host-local", kind: "unary", method: "epic.localHistory.read" },
    ]);

    expect(view).toEqual(HISTORY_COMPOSED_VIEW);
    expect(Object.isFrozen(view.contributors)).toBe(true);
  });

  it("throws at definition when a contributor id is declared twice", () => {
    expect(() =>
      defineComposedView("dup", [
        { id: "a", kind: "unary", method: "epic.listTasks" },
        { id: "a", kind: "unary", method: "epic.localHistory.read" },
      ]),
    ).toThrow("dup: contributor a is declared twice");
  });

  it("throws at definition for a method the registry of its kind does not carry", () => {
    expect(() =>
      defineComposedView("missing", [
        { id: "a", kind: "unary", method: "epic.noSuchMethod" },
      ]),
    ).toThrow("is not a registered bridge");
    expect(() =>
      defineComposedView("wrong-kind", [
        { id: "a", kind: "stream", method: "epic.listTasks" },
      ]),
    ).toThrow("is not a registered bridge");
  });
});

describe("intersectRole", () => {
  it.each([
    ["owner", "viewer", "viewer"],
    ["viewer", "editor", "viewer"],
    ["editor", "owner", "editor"],
    ["editor", "editor", "editor"],
  ] as const)("%s with %s is %s", (left, right, expected) => {
    expect(intersectRole(left, right)).toBe(expected);
  });
});
