import { describe, expect, it } from "vitest";
import {
  focusLayoutRef,
  repairLayout,
  replaceLayoutRef,
  tabItemId,
  tabRefKey,
  type PersistedTabStripLayout,
} from "../layout";
import { setLayoutTabGroup } from "../tab-groups";
import { migrateTabsPersistedState, useTabsStore } from "../store";

const a = { kind: "epic" as const, id: "a" };
const b = { kind: "epic" as const, id: "b" };
const c = { kind: "epic" as const, id: "c" };
const group = { name: "Project", color: "#8ab4f8", collapsed: false };

function layout(
  overrides: Partial<PersistedTabStripLayout>,
): PersistedTabStripLayout {
  return {
    version: 2,
    items: [
      { kind: "tab", id: tabItemId(a), ref: a },
      { kind: "tab", id: tabItemId(b), ref: b },
      { kind: "tab", id: tabItemId(c), ref: c },
    ],
    activeItemId: tabItemId(a),
    systemTabs: { history: null, settings: null },
    ...overrides,
  };
}

describe("manual tab groups", () => {
  it("keeps grouped items contiguous and prunes closed members/groups", () => {
    const repaired = repairLayout(
      layout({
        items: [
          { kind: "tab", id: tabItemId(a), ref: a },
          { kind: "tab", id: tabItemId(b), ref: b },
          { kind: "tab", id: tabItemId(c), ref: c },
        ],
        customizations: {
          [tabRefKey(a)]: { color: null, icon: null, groupId: "g" },
          [tabRefKey(c)]: { color: null, icon: null, groupId: "g" },
        },
        groups: { g: group, dead: { ...group, name: "Dead" } },
      }),
      (kind): kind is "epic" => kind === "epic",
    );

    expect(repaired.items.map((item) => item.id)).toEqual([
      tabItemId(a),
      tabItemId(c),
      tabItemId(b),
    ]);
    expect(repaired.groups).toEqual({ g: group });
  });

  it("applies group membership to both sides of a split", () => {
    const split = {
      kind: "split" as const,
      id: "split",
      left: { kind: "tab" as const, ref: a },
      right: { kind: "tab" as const, ref: b },
      focusedSide: "left" as const,
      routeBackingSide: "left" as const,
      leftRatio: 0.5,
    };
    const result = setLayoutTabGroup(
      layout({ items: [split], groups: { g: group } }),
      a,
      "g",
    );
    expect(result.customizations?.[tabRefKey(a)]?.groupId).toBe("g");
    expect(result.customizations?.[tabRefKey(b)]?.groupId).toBe("g");
  });

  it.each([
    {
      name: "the first member's color",
      leftColor: "#ef4444",
      expectedColor: "#ef4444",
    },
    {
      name: "the other populated member's color when the first is unset",
      leftColor: null,
      expectedColor: "#f97316",
    },
  ])("repairs split colors from $name", ({ leftColor, expectedColor }) => {
    const split = {
      kind: "split" as const,
      id: "split-repair-colors",
      left: { kind: "tab" as const, ref: a },
      right: { kind: "tab" as const, ref: b },
      focusedSide: "left" as const,
      routeBackingSide: "left" as const,
      leftRatio: 0.5,
    };
    const repaired = repairLayout(
      layout({
        items: [split],
        customizations: {
          [tabRefKey(a)]: { color: leftColor, icon: "A", groupId: null },
          [tabRefKey(b)]: { color: "#f97316", icon: "B", groupId: null },
        },
      }),
      (kind): kind is "epic" => kind === "epic",
    );

    expect(repaired.customizations).toMatchObject({
      [tabRefKey(a)]: { color: expectedColor, icon: "A" },
      [tabRefKey(b)]: { color: expectedColor, icon: "B" },
    });
  });

  it("transfers customization when a draft ref is replaced", () => {
    const draft = { kind: "draft" as const, id: "draft-1" };
    const result = replaceLayoutRef(
      layout({
        items: [{ kind: "tab", id: tabItemId(draft), ref: draft }],
        customizations: {
          [tabRefKey(draft)]: { color: "#f28b82", icon: "★", groupId: null },
        },
      }),
      { previous: draft, next: a },
    );
    expect(result.customizations?.[tabRefKey(a)]).toEqual({
      color: "#f28b82",
      icon: "★",
      groupId: null,
    });
    expect(result.customizations?.[tabRefKey(draft)]).toBeUndefined();
  });

  it("expands a collapsed group when one of its tabs is focused", () => {
    const result = focusLayoutRef(
      layout({
        customizations: {
          [tabRefKey(a)]: { color: null, icon: null, groupId: "g" },
        },
        groups: { g: { ...group, collapsed: true } },
      }),
      a,
    );
    expect(result.groups?.g.collapsed).toBe(false);
  });

  it("stores a manual color and icon customization by tab ref", () => {
    useTabsStore.setState({
      ...layout({}),
      stripOrder: [a, b, c],
    });
    useTabsStore.getState().setTabCustomization(a, {
      color: "#fdd663",
      icon: "★",
    });
    expect(
      useTabsStore.getState().customizations?.[tabRefKey(a)],
    ).toMatchObject({
      color: "#fdd663",
      icon: "★",
    });
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it.each(["left", "right"] as const)(
    "copies the destination color to a dropped tab on the %s side while preserving icons",
    (destinationSide) => {
      const droppedSide = destinationSide === "left" ? "right" : "left";
      useTabsStore.setState({
        ...layout({
          customizations: {
            [tabRefKey(a)]: { color: "#ef4444", icon: "D", groupId: null },
            [tabRefKey(b)]: { color: "#f97316", icon: "O", groupId: null },
          },
        }),
        stripOrder: [a, b, c],
      });

      useTabsStore.getState().pair({
        left: destinationSide === "left" ? a : b,
        right: destinationSide === "left" ? b : a,
        splitId: "split-color",
        leftRatio: 0.5,
        targetRef: a,
      });

      const split = useTabsStore.getState().items[0];
      expect(split.kind).toBe("split");
      if (split.kind === "split") {
        const destination = split[destinationSide];
        const dropped = split[droppedSide];
        expect(destination.kind).toBe("tab");
        expect(dropped.kind).toBe("tab");
        if (destination.kind !== "tab" || dropped.kind !== "tab") return;
        expect(
          useTabsStore.getState().customizations?.[tabRefKey(destination.ref)],
        ).toMatchObject({ color: "#ef4444", icon: "D" });
        expect(
          useTabsStore.getState().customizations?.[tabRefKey(dropped.ref)],
        ).toMatchObject({ color: "#ef4444", icon: "O" });
      }

      useTabsStore.setState(useTabsStore.getInitialState(), true);
    },
  );

  it("propagates split color changes through either member while keeping icons independent", () => {
    const split = {
      kind: "split" as const,
      id: "split-colors",
      left: { kind: "tab" as const, ref: a },
      right: { kind: "tab" as const, ref: b },
      focusedSide: "left" as const,
      routeBackingSide: "left" as const,
      leftRatio: 0.5,
    };
    useTabsStore.setState({
      ...layout({
        items: [split],
        customizations: {
          [tabRefKey(a)]: { color: "#ef4444", icon: "A", groupId: null },
          [tabRefKey(b)]: { color: "#ef4444", icon: "B", groupId: null },
        },
      }),
      stripOrder: [a, b],
    });

    useTabsStore.getState().setTabCustomization(a, { color: "#3b82f6" });
    expect(useTabsStore.getState().customizations).toMatchObject({
      [tabRefKey(a)]: { color: "#3b82f6", icon: "A" },
      [tabRefKey(b)]: { color: "#3b82f6", icon: "B" },
    });

    useTabsStore.getState().setTabCustomization(b, { color: "#22c55e" });
    expect(useTabsStore.getState().customizations).toMatchObject({
      [tabRefKey(a)]: { color: "#22c55e", icon: "A" },
      [tabRefKey(b)]: { color: "#22c55e", icon: "B" },
    });
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it("inherits the populated member color when filling an empty split side", () => {
    const split = {
      kind: "split" as const,
      id: "split-empty",
      left: { kind: "tab" as const, ref: a },
      right: { kind: "empty" as const },
      focusedSide: "right" as const,
      routeBackingSide: "left" as const,
      leftRatio: 0.5,
    };
    useTabsStore.setState({
      ...layout({
        items: [split],
        customizations: {
          [tabRefKey(a)]: { color: "#ef4444", icon: "A", groupId: null },
        },
      }),
      stripOrder: [a],
    });

    useTabsStore.getState().replaceFillableSide({
      splitId: "split-empty",
      side: "right",
      ref: b,
    });

    expect(
      useTabsStore.getState().customizations?.[tabRefKey(b)],
    ).toMatchObject({ color: "#ef4444" });
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it("restores customization and group metadata from persisted state", () => {
    const restored = migrateTabsPersistedState({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(a), ref: a }],
      activeItemId: tabItemId(a),
      systemTabs: { history: null, settings: null },
      customizations: {
        [tabRefKey(a)]: { color: "#fdd663", icon: "★", groupId: "g" },
      },
      groups: { g: group },
    });
    expect(restored.customizations?.[tabRefKey(a)]).toEqual({
      color: "#fdd663",
      icon: "★",
      groupId: "g",
    });
    expect(restored.groups).toEqual({ g: group });
  });
});
