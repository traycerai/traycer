import { describe, expect, it } from "vitest";
import { grantedRole } from "@traycer/protocol/common/permission-role";
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
  // Compared as access, not as the spelling handed back: a `viewer` role gives
  // the access of `editor`, so neither spelling is the lesser of the two.
  it.each([
    ["owner", "viewer", "editor"],
    ["viewer", "editor", "editor"],
    ["viewer", "viewer", "editor"],
    ["editor", "owner", "editor"],
    ["editor", "editor", "editor"],
    ["owner", "owner", "owner"],
  ] as const)("%s with %s gives %s access", (left, right, expected) => {
    expect(grantedRole(intersectRole(left, right))).toBe(expected);
  });
});
