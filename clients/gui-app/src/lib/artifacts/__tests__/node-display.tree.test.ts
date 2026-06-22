import { describe, expect, it } from "vitest";
import {
  buildEpicNodeTree,
  type EpicNodeRecord,
} from "@/lib/artifacts/node-display";

describe("buildEpicNodeTree", () => {
  it("preserves insertion order and lifts unknown parents to the root", () => {
    const records: EpicNodeRecord[] = [
      {
        id: "spec",
        parentId: null,
        name: "Spec",
        type: "spec",
        hostId: "test-host",
      },
      {
        id: "chat",
        parentId: "spec",
        name: "Chat",
        type: "chat",
        hostId: "test-host",
      },
      {
        id: "ticket",
        parentId: "spec",
        name: "Ticket",
        type: "ticket",
        hostId: "test-host",
      },
      {
        id: "orphan",
        parentId: "missing-parent",
        name: "Orphan",
        type: "story",
        hostId: "test-host",
      },
    ];

    expect(buildEpicNodeTree(records)).toEqual([
      {
        id: "spec",
        data: {
          name: "Spec",
          type: "spec",
          hostId: "test-host",
        },
        isGroup: true,
        children: [
          {
            id: "chat",
            data: {
              name: "Chat",
              type: "chat",
              hostId: "test-host",
            },
            isGroup: false,
          },
          {
            id: "ticket",
            data: {
              name: "Ticket",
              type: "ticket",
              hostId: "test-host",
            },
            isGroup: false,
          },
        ],
      },
      {
        id: "orphan",
        data: {
          name: "Orphan",
          type: "story",
          hostId: "test-host",
        },
        isGroup: false,
      },
    ]);
  });
});
