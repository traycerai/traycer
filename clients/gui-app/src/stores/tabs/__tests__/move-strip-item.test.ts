import { describe, expect, it } from "vitest";
import {
  moveStripItem,
  tabItemId,
  tabRefKey,
  type PersistedTabStripLayout,
  type StripItem,
} from "../layout";
import type { TabGroup } from "../tab-groups";
import type { TabRef } from "../types";

function ref(id: string): TabRef {
  return { kind: "epic", id };
}

function item(id: string): StripItem {
  return { kind: "tab", id: tabItemId(ref(id)), ref: ref(id) };
}

function group(collapsed: boolean): TabGroup {
  return { name: "H", color: "#8ab4f8", collapsed };
}

/** `l`, the group "h" of `m` and `r`, then `x`. */
function layoutWith(collapsed: boolean): PersistedTabStripLayout {
  return {
    version: 2,
    items: ["l", "m", "r", "x"].map(item),
    activeItemId: null,
    systemTabs: { history: null, settings: null },
    customizations: Object.fromEntries(
      ["m", "r"].map((id) => [
        tabRefKey(ref(id)),
        { color: null, icon: null, groupId: "h" },
      ]),
    ),
    groups: { h: group(collapsed) },
  };
}

function order(layout: PersistedTabStripLayout): ReadonlyArray<string> {
  return layout.items.map((entry) =>
    entry.kind === "tab" ? entry.ref.id : "",
  );
}

function groupOf(layout: PersistedTabStripLayout, id: string): string | null {
  return layout.customizations?.[tabRefKey(ref(id))]?.groupId ?? null;
}

describe("moveStripItem", () => {
  it("lands a drop that joins the group where it was drawn, among its tabs", () => {
    const moved = moveStripItem(layoutWith(false), {
      itemId: tabItemId(ref("x")),
      targetIndex: 2,
      groupId: "h",
    });

    expect(order(moved)).toEqual(["l", "m", "x", "r"]);
    expect(groupOf(moved, "x")).toBe("h");
  });

  it("lands a drop that does not join a group outside its run, not between its tabs", () => {
    // A sectioned strip draws only some of the group's tabs, so the place a drop
    // was drawn at, before `r`, can fall between `m` and `r`. Left there the
    // commit's repair would move it after both, where it was not drawn.
    const moved = moveStripItem(layoutWith(false), {
      itemId: tabItemId(ref("x")),
      targetIndex: 2,
      groupId: null,
    });

    expect(order(moved)).toEqual(["l", "x", "m", "r"]);
    expect(groupOf(moved, "x")).toBeNull();
  });

  it("joins a collapsed group at the head of its run, and leaves it collapsed", () => {
    const moved = moveStripItem(layoutWith(true), {
      itemId: tabItemId(ref("x")),
      targetIndex: 4,
      groupId: "h",
    });

    expect(order(moved)).toEqual(["l", "x", "m", "r"]);
    expect(groupOf(moved, "x")).toBe("h");
    expect(moved.groups?.h.collapsed).toBe(true);
  });

  it("keeps the place a collapsed group's only tab is dropped at, in its own group", () => {
    const layout: PersistedTabStripLayout = {
      ...layoutWith(true),
      items: ["l", "m", "x"].map(item),
      customizations: {
        [tabRefKey(ref("m"))]: { color: null, icon: null, groupId: "h" },
      },
    };

    const moved = moveStripItem(layout, {
      itemId: tabItemId(ref("m")),
      targetIndex: 3,
      groupId: "h",
    });

    expect(order(moved)).toEqual(["l", "x", "m"]);
    expect(groupOf(moved, "m")).toBe("h");
  });

  it("is the layout it was given when the drop changes nothing", () => {
    const layout = layoutWith(false);

    expect(
      moveStripItem(layout, {
        itemId: tabItemId(ref("x")),
        targetIndex: 4,
        groupId: null,
      }),
    ).toBe(layout);
  });
});
