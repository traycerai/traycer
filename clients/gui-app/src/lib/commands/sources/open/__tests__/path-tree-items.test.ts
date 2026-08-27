import { describe, expect, it, vi } from "vitest";
import type { CommandItem } from "@/lib/commands/types";
import { buildPathTreeItems } from "@/lib/commands/sources/open/path-tree-items";

function item(id: string, label: string): CommandItem {
  return {
    id,
    label,
    description: null,
    keywords: [label],
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: vi.fn(),
  };
}

describe("buildPathTreeItems", () => {
  it("coalesces an actionable parent leaf with its directory node", () => {
    const parent = item("parent", "Spec");
    const child = item("child", "Ticket");
    const rows = buildPathTreeItems(
      "artifacts",
      [
        {
          item: parent,
          path: "parent",
          displaySegments: ["Spec"],
          structuralSegments: ["parent"],
          gitStatus: undefined,
        },
        {
          item: child,
          path: "child",
          displaySegments: ["Spec", "Ticket"],
          structuralSegments: ["parent", "child"],
          gitStatus: undefined,
        },
      ],
      [],
    );

    expect(rows.map((row) => row.id)).toEqual(["parent", "child"]);
    expect(rows[0]?.pathTreeRow).toMatchObject({
      kind: "file",
      hasChildren: true,
      nodeId: "parent",
    });
    expect(rows[0]?.run).toBe(parent.run);
    expect(rows[1]?.pathTreeRow?.ancestorIds).toEqual(["parent"]);
  });
});
