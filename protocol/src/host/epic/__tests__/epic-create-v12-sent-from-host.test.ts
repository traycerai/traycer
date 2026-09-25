import { describe, expect, it } from "vitest";
import {
  epicCreateChatUpgradeV11ToV12,
  epicCreateUpgradeV11ToV12,
} from "@traycer/protocol/host/epic/contracts";
import {
  createChatInitialMessageSchemaV12,
  createChatRequestSchemaV12,
  createEpicRequestSchemaV12,
  type CreateChatRequestV11,
  type CreateEpicRequest,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * `epic.create@1.2` / `epic.createChat@1.2`'s initial message carries
 * `sentFromHostId`: the machine the creating app runs on, which the host
 * places a routed browser realm by on the chat's first turn, exactly as a
 * `chat.subscribe` `send` frame's key does on every later one.
 *
 * The key grew on the `@1.2` leaf in place (both `@1.2` lines are
 * unreleased; the released-baseline fixture is the proof the `@1.0`/`@1.1`
 * lines did not move), so the only compatibility work is the `@1.1 -> @1.2`
 * upgrade path: a `@1.1` caller names no machine, and its initial message
 * arrives at the `@1.2` resolver with the honest `null`.
 */

const settings = {
  harnessId: "codex" as const,
  model: "gpt-5.4",
  permissionMode: "supervised" as const,
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
};

const initialMessageV11 = {
  messageId: "message-1",
  clientActionId: "action-1",
  content: { type: "doc", content: [] },
  sender: { type: "user" as const, userId: "user-1" },
  settings,
  accountContext: { type: "PERSONAL" as const },
};

const epicLight = {
  id: "epic-1",
  title: "Epic",
  initialUserPrompt: "Do the thing",
  ticketCount: 0,
  specCount: 0,
  storyCount: 0,
  reviewCount: 0,
  status: "in_progress",
  createdAt: 1000,
  updatedAt: 1000,
  createdBy: "user-1",
  version: "1",
};

describe("createChatInitialMessageSchemaV12.sentFromHostId", () => {
  it("defaults an absent key to null, so a create that names no machine parses", () => {
    const parsed = createChatInitialMessageSchemaV12.parse(initialMessageV11);
    expect(parsed.sentFromHostId).toBeNull();
  });

  it("round-trips a host id and an explicit null", () => {
    expect(
      createChatInitialMessageSchemaV12.parse({
        ...initialMessageV11,
        sentFromHostId: "host-2",
      }).sentFromHostId,
    ).toBe("host-2");
    expect(
      createChatInitialMessageSchemaV12.parse({
        ...initialMessageV11,
        sentFromHostId: null,
      }).sentFromHostId,
    ).toBeNull();
  });
});

describe("epicCreateChatUpgradeV11ToV12 fills sentFromHostId", () => {
  const base: CreateChatRequestV11 = {
    epicId: "epic-1",
    parentId: null,
    hostId: "host-1",
    title: "Chat",
    chatId: "chat-1",
  };

  it("names no machine for a @1.1 caller's initial message", () => {
    const upgraded = epicCreateChatUpgradeV11ToV12.upgradeRequest({
      ...base,
      initialMessage: initialMessageV11,
    });
    expect(upgraded.initialMessage).toEqual({
      ...initialMessageV11,
      sentFromHostId: null,
    });
    // The filled request is a well-formed @1.2 request as-is.
    expect(createChatRequestSchemaV12.parse(upgraded).initialMessage).toEqual(
      upgraded.initialMessage,
    );
  });

  it("leaves a null or absent initial message alone", () => {
    expect(
      epicCreateChatUpgradeV11ToV12.upgradeRequest({
        ...base,
        initialMessage: null,
      }).initialMessage,
    ).toBeNull();
    expect(
      epicCreateChatUpgradeV11ToV12.upgradeRequest(base).initialMessage,
    ).toBeUndefined();
  });
});

describe("epicCreateUpgradeV11ToV12 fills sentFromHostId on the folded chat", () => {
  const base: CreateEpicRequest = {
    epic: epicLight,
    repoIdentifiers: [],
    workspaces: [],
    chat: null,
  };

  it("names no machine for a @1.1 caller's folded initial message", () => {
    const upgraded = epicCreateUpgradeV11ToV12.upgradeRequest({
      ...base,
      chat: {
        chatId: "chat-1",
        parentId: null,
        hostId: "host-1",
        title: "Chat",
        worktreeIntent: null,
        initialMessage: initialMessageV11,
      },
    });
    expect(upgraded.chat?.initialMessage).toEqual({
      ...initialMessageV11,
      sentFromHostId: null,
    });
    expect(
      createEpicRequestSchemaV12.parse(upgraded).chat?.initialMessage,
    ).toEqual(upgraded.chat?.initialMessage);
  });

  it("leaves a null chat, and a chat with no initial message, alone", () => {
    expect(epicCreateUpgradeV11ToV12.upgradeRequest(base).chat).toBeNull();
    const withoutMessage = epicCreateUpgradeV11ToV12.upgradeRequest({
      ...base,
      chat: {
        chatId: "chat-1",
        parentId: null,
        hostId: "host-1",
        title: "Chat",
        worktreeIntent: null,
        initialMessage: null,
      },
    });
    expect(withoutMessage.chat?.initialMessage).toBeNull();
  });
});
