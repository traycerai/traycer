import { describe, expect, it } from "vitest";
import { parseTileRef } from "@/stores/epics/canvas/tile-schema";

const SPELLINGS = [
  "Untitled agent",
  "Untitled chat",
  "Untitled terminal agent",
];

function savedTile(type: string, name: string): Record<string, unknown> {
  const base = { type, name, instanceId: "inst-1", hostId: "host-1" };
  if (type === "published-chat") {
    return {
      ...base,
      taskId: "task-1",
      chatId: "chat-1",
      ownerUserId: "user-1",
      ownerHostId: "host-2",
    };
  }
  return { ...base, id: "node-1" };
}

describe("a saved tile's name on load", () => {
  describe.each(["chat", "terminal-agent", "published-chat"])("%s", (type) => {
    it.each(SPELLINGS)("loads a saved %j as New agent", (name) => {
      expect(parseTileRef(savedTile(type, name))?.name).toBe("New agent");
    });

    it("keeps a real title", () => {
      expect(parseTileRef(savedTile(type, "Planner"))?.name).toBe("Planner");
    });
  });

  it.each(["spec", "ticket"])(
    "keeps a saved %s named 'Untitled chat' as it was",
    (type) => {
      expect(parseTileRef(savedTile(type, "Untitled chat"))?.name).toBe(
        "Untitled chat",
      );
    },
  );
});
