import { describe, expect, it } from "vitest";
import {
  stripRowsOf,
  taskPinReadOf,
} from "@/components/layout/tabs/tab-strip-rows";
import { tabItemId, tabRefKey, type StripItem } from "@/stores/tabs/layout";
import type {
  TabCustomizations,
  TabGroup,
  TabGroups,
} from "@/stores/tabs/tab-groups";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";

const A: TabRef = { kind: "epic", id: "a" };
const B: TabRef = { kind: "epic", id: "b" };
const C: TabRef = { kind: "epic", id: "c" };
const D: TabRef = { kind: "draft", id: "d" };

function tab(ref: TabRef): StripItem {
  return { kind: "tab", id: tabItemId(ref), ref };
}

const SPLIT_BC: StripItem = {
  kind: "split",
  id: "split:bc",
  left: { kind: "tab", ref: B },
  right: { kind: "tab", ref: C },
  focusedSide: "left",
  routeBackingSide: "left",
  leftRatio: 0.5,
};

const SPLIT_D_EMPTY: StripItem = {
  kind: "split",
  id: "split:d",
  left: { kind: "tab", ref: D },
  right: { kind: "empty" },
  focusedSide: "left",
  routeBackingSide: "left",
  leftRatio: 0.5,
};

function grouped(
  entries: ReadonlyArray<readonly [TabRef, string]>,
): TabCustomizations {
  return Object.fromEntries(
    entries.map(([ref, groupId]) => [
      tabRefKey(ref),
      { color: null, icon: null, groupId },
    ]),
  );
}

function group(collapsed: boolean): TabGroup {
  return { name: "Work", color: "#8ab4f8", collapsed };
}

function ids(items: ReadonlyArray<StripItem>): ReadonlyArray<string> {
  return items.map((item) => item.id);
}

describe("stripRowsOf", () => {
  it("counts tab members before each item, a split counting its tab halves", () => {
    const items = [tab(A), SPLIT_BC, SPLIT_D_EMPTY, tab(D)];
    const rows = stripRowsOf(ids(items), items, undefined, undefined);
    expect(rows.map((row) => row.memberOffset)).toEqual([0, 1, 3, 4]);
    expect(rows.map((row) => row.stripIndex)).toEqual([0, 1, 2, 3]);
    expect(rows.map((row) => row.itemId)).toEqual(ids(items));
  });

  it("starts a group on its first member only, and again after a break", () => {
    const items = [tab(A), tab(B), tab(C), tab(D)];
    const groups: TabGroups = { g: group(false) };
    const customizations = grouped([
      [A, "g"],
      [B, "g"],
      [D, "g"],
    ]);
    const rows = stripRowsOf(ids(items), items, groups, customizations);
    expect(rows.map((row) => row.groupStart?.groupId ?? null)).toEqual([
      "g",
      null,
      null,
      "g",
    ]);
    expect(rows.every((row) => !row.hidden)).toBe(true);
  });

  it("names the group on every member, not only the first", () => {
    const items = [tab(A), tab(B), tab(C)];
    const groups: TabGroups = { g: group(false) };
    const customizations = grouped([
      [A, "g"],
      [B, "g"],
    ]);
    const rows = stripRowsOf(ids(items), items, groups, customizations);
    expect(rows.map((row) => row.group?.groupId ?? null)).toEqual([
      "g",
      "g",
      null,
    ]);
  });

  it("hides the members of a collapsed group but keeps its start", () => {
    const items = [tab(A), tab(B), tab(C)];
    const groups: TabGroups = { g: group(true) };
    const customizations = grouped([
      [A, "g"],
      [B, "g"],
    ]);
    const rows = stripRowsOf(ids(items), items, groups, customizations);
    expect(rows.map((row) => row.hidden)).toEqual([true, true, false]);
    expect(rows[0]?.groupStart).toEqual({ groupId: "g", group: group(true) });
  });

  it("draws no group start for a group id with no group record", () => {
    const items = [tab(A)];
    const rows = stripRowsOf(ids(items), items, {}, grouped([[A, "missing"]]));
    expect(rows[0]?.groupStart).toBeNull();
    expect(rows[0]?.group).toBeNull();
    expect(rows[0]?.hidden).toBe(false);
  });
});

describe("taskPinReadOf", () => {
  const epicTab: HeaderTab = {
    kind: "epic",
    id: "a",
    epicId: "epic-a",
    hostId: null,
    route: "/epics/epic-a/a",
    name: "Alpha",
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
  };
  const draftTab: HeaderTab = {
    kind: "draft",
    id: "d",
    route: "/drafts/d",
    name: "Draft",
    icon: null,
    canDuplicate: true,
    canOpenInNewWindow: true,
  };
  const pinned: TaskPinnedState = {
    pinned: true,
    home: undefined,
    hostId: null,
    pinnedKnown: true,
  };
  const states: ReadonlyMap<string, TaskPinnedState> = new Map([
    ["epic-a", pinned],
  ]);

  it("reads an epic tab's pin state and pending flag by epic id", () => {
    expect(taskPinReadOf(epicTab, states, new Set(["epic-a"]))).toEqual({
      taskPinnedState: pinned,
      isTaskPinPending: true,
    });
    expect(taskPinReadOf(epicTab, new Map(), new Set())).toEqual({
      taskPinnedState: null,
      isTaskPinPending: false,
    });
  });

  it("gives a non-epic tab no pin state", () => {
    expect(taskPinReadOf(draftTab, states, new Set(["d"]))).toEqual({
      taskPinnedState: null,
      isTaskPinPending: false,
    });
  });
});
