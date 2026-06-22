import { describe, expect, it } from "vitest";
import {
  bucketItems,
  buildPinnedBucket,
  buildRecentsBucket,
  filterByScope,
} from "@/lib/commands/grouping";
import type { CommandItem } from "@/lib/commands/types";

function stub(
  partial: Partial<CommandItem> & Pick<CommandItem, "id" | "label">,
): CommandItem {
  return {
    description: null,
    keywords: [],
    group: "actions",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => undefined,
    ...partial,
  };
}

describe("bucketItems", () => {
  it("groups items by group id, drops empty groups, and alphabetizes each group", () => {
    const items: ReadonlyArray<CommandItem> = [
      stub({ id: "a", label: "Zeta", group: "actions" }),
      stub({ id: "b", label: "Alpha", group: "actions" }),
      stub({ id: "c", label: "Home", group: "navigation" }),
    ];
    const buckets = bucketItems(items);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].id).toBe("actions");
    expect(buckets[0].items.map((i) => i.label)).toEqual(["Alpha", "Zeta"]);
    expect(buckets[1].id).toBe("navigation");
  });

  it("ordering follows DEFAULT_GROUP_ORDER (actions before theme before help)", () => {
    const items: ReadonlyArray<CommandItem> = [
      stub({ id: "t", label: "Theme: Dark", group: "theme" }),
      stub({ id: "a", label: "Open settings", group: "actions" }),
      stub({ id: "h", label: "Help", group: "help" }),
    ];
    const order = bucketItems(items).map((b) => b.id);
    expect(order).toEqual(["actions", "theme", "help"]);
  });
});

describe("filterByScope", () => {
  const items: ReadonlyArray<CommandItem> = [
    stub({ id: "a", label: "A", scope: "actions" }),
    stub({ id: "e", label: "E", scope: "epics" }),
    stub({ id: "h", label: "H", scope: "help" }),
  ];

  it("returns the pool untouched when scope is null", () => {
    expect(filterByScope(items, null)).toHaveLength(3);
  });

  it("returns only items matching the active scope", () => {
    expect(filterByScope(items, "epics").map((i) => i.id)).toEqual(["e"]);
  });
});

describe("buildRecentsBucket", () => {
  const pool: ReadonlyArray<CommandItem> = [
    stub({ id: "alpha", label: "A" }),
    stub({ id: "beta", label: "B" }),
  ];

  it("returns null when there are no recent ids", () => {
    expect(buildRecentsBucket([], pool)).toBeNull();
  });

  it("preserves recent order and silently drops ids missing from the pool", () => {
    const bucket = buildRecentsBucket(["beta", "missing", "alpha"], pool);
    expect(bucket).not.toBeNull();
    expect(bucket?.items.map((i) => i.id)).toEqual(["beta", "alpha"]);
  });

  it("returns null when every recent id is missing from the pool", () => {
    expect(buildRecentsBucket(["gone"], pool)).toBeNull();
  });
});

describe("buildPinnedBucket", () => {
  const pool: ReadonlyArray<CommandItem> = [
    stub({ id: "x", label: "X" }),
    stub({ id: "y", label: "Y" }),
  ];

  it("returns null when there are no pinned ids", () => {
    expect(buildPinnedBucket([], pool)).toBeNull();
  });

  it("preserves pinned order", () => {
    const bucket = buildPinnedBucket(["y", "x"], pool);
    expect(bucket?.items.map((i) => i.id)).toEqual(["y", "x"]);
  });
});
