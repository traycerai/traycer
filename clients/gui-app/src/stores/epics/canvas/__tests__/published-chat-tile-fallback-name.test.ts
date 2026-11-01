import { describe, expect, it } from "vitest";
import { publishedChatTileSchema } from "@/stores/epics/canvas/tile-schema/published-chat-tile";

describe("publishedChatTileSchema", () => {
  it("names a persisted published tile that carries no name New agent", () => {
    const parsed = publishedChatTileSchema.parse({
      type: "published-chat",
      taskId: "task-1",
      chatId: "chat-1",
      ownerUserId: "user-1",
    });

    expect(parsed?.name).toBe("New agent");
  });
});
