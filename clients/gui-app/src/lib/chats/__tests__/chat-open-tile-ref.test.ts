import { describe, expect, it } from "vitest";
import {
  chatOpensPublishedCopy,
  makeChatOpenTileRef,
} from "@/lib/chats/chat-open-tile-ref";

const BASE_INPUT = {
  taskId: "epic-1",
  chatId: "chat-1",
  name: "Cross-host chat",
  ownerHostId: "host-owner",
  ownerUserId: "user-owner",
  ownerRefusesStore: false,
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

  it("opens a published copy through the session host when a reachable owner refuses the epic's store", () => {
    const ref = makeChatOpenTileRef({
      ...BASE_INPUT,
      ownerIsUnreachable: false,
      ownerRefusesStore: true,
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

  it("keeps the owner-bound live ref when the refusing owner has no persisted cloud user id", () => {
    const ref = makeChatOpenTileRef({
      ...BASE_INPUT,
      ownerUserId: null,
      ownerIsUnreachable: false,
      ownerRefusesStore: true,
    });

    expect(ref).toMatchObject({
      type: "chat",
      hostId: "host-owner",
    });
  });
});

describe("chatOpensPublishedCopy", () => {
  it("is false for a non-chat ref regardless of owner state", () => {
    expect(
      chatOpensPublishedCopy({
        isChat: false,
        ownerHostId: "host-owner",
        ownerUserId: "user-owner",
        ownerIsUnreachable: true,
        ownerRefusesStore: true,
      }),
    ).toBe(false);
  });

  it("is false for a reachable owner with no refusal", () => {
    expect(
      chatOpensPublishedCopy({
        isChat: true,
        ownerHostId: "host-owner",
        ownerUserId: "user-owner",
        ownerIsUnreachable: false,
        ownerRefusesStore: false,
      }),
    ).toBe(false);
  });

  it("is true for an unreachable owner", () => {
    expect(
      chatOpensPublishedCopy({
        isChat: true,
        ownerHostId: "host-owner",
        ownerUserId: "user-owner",
        ownerIsUnreachable: true,
        ownerRefusesStore: false,
      }),
    ).toBe(true);
  });

  it("is true for a reachable owner that refuses the store", () => {
    expect(
      chatOpensPublishedCopy({
        isChat: true,
        ownerHostId: "host-owner",
        ownerUserId: "user-owner",
        ownerIsUnreachable: false,
        ownerRefusesStore: true,
      }),
    ).toBe(true);
  });

  it("is false for a refusal with no persisted owner host id", () => {
    expect(
      chatOpensPublishedCopy({
        isChat: true,
        ownerHostId: null,
        ownerUserId: "user-owner",
        ownerIsUnreachable: false,
        ownerRefusesStore: true,
      }),
    ).toBe(false);
  });
});
