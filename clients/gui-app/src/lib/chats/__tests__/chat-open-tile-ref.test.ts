import { describe, expect, it } from "vitest";
import { makeChatOpenTileRef } from "@/lib/chats/chat-open-tile-ref";

const BASE_INPUT = {
  taskId: "epic-1",
  chatId: "chat-1",
  name: "Cross-host chat",
  ownerHostId: "host-owner",
  ownerUserId: "user-owner",
  sessionHostId: "host-session",
} as const;

describe("makeChatOpenTileRef", () => {
  it("binds a reachable chat to its persisted owner host", () => {
    const ref = makeChatOpenTileRef({
      ...BASE_INPUT,
      ownerIsUnreachable: false,
    });

    expect(ref).toMatchObject({
      id: "chat-1",
      type: "chat",
      hostId: "host-owner",
    });
  });

  it("opens a published copy through the session host when the owner is unreachable", () => {
    const ref = makeChatOpenTileRef({
      ...BASE_INPUT,
      ownerIsUnreachable: true,
    });

    expect(ref).toMatchObject({
      type: "published-chat",
      hostId: "host-session",
      taskId: "epic-1",
      chatId: "chat-1",
      ownerUserId: "user-owner",
      ownerHostId: "host-owner",
    });
  });

  it("keeps the owner-bound live fallback when a published identity is incomplete", () => {
    const ref = makeChatOpenTileRef({
      ...BASE_INPUT,
      ownerUserId: null,
      ownerIsUnreachable: true,
    });

    expect(ref).toMatchObject({
      type: "chat",
      hostId: "host-owner",
    });
  });

  it("uses the session host for a legacy chat with no persisted owner", () => {
    const ref = makeChatOpenTileRef({
      ...BASE_INPUT,
      ownerHostId: null,
      ownerIsUnreachable: true,
    });

    expect(ref).toMatchObject({
      type: "chat",
      hostId: "host-session",
    });
  });
});
