import { describe, expect, it } from "vitest";
import {
  epicCreateUpgradeV13ToV14,
  epicCreateV13,
  epicCreateV14,
} from "@traycer/protocol/host/epic/contracts";

/**
 * `epic.create@1.4`: the folded first chat's opening carries the per-chat
 * Ultracode request, and everything `@1.3` meant (the team owner, the epic,
 * the chat seed's other fields) survives it. A `@1.3` request cannot carry the
 * request, and upgrading one states it as false.
 */

const epicLight = {
  id: "epic-1",
  title: "Epic",
  initialUserPrompt: "Do the thing",
  ticketCount: 0,
  specCount: 0,
  storyCount: 0,
  reviewCount: 0,
  status: "todo",
  createdAt: 1000,
  updatedAt: 1000,
  createdBy: "user-1",
  version: "2.0.0",
};

const SETTINGS = {
  harnessId: "claude",
  model: "claude-sonnet-4-20250514",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function request(ultracode: boolean) {
  return {
    epic: epicLight,
    repoIdentifiers: [],
    workspaces: [],
    owner: { kind: "team", teamId: "team-1" },
    chat: {
      chatId: "chat-1",
      parentId: null,
      hostId: "host-1",
      title: "First chat",
      worktreeIntent: null,
      initialMessage: {
        messageId: "message-1",
        clientActionId: "action-1",
        content: { type: "doc", content: [] },
        sender: { type: "user", userId: "user-1" },
        settings: { ...SETTINGS, ultracode },
        accountContext: { type: "PERSONAL" },
      },
    },
  };
}

function hasUltracode(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "ultracode")
  );
}

describe("epic.create@1.4 folded opening", () => {
  it("keeps true in the opening and the team owner beside it", () => {
    const parsed = epicCreateV14.requestSchema.parse(request(true));
    expect(parsed.chat?.initialMessage?.settings.ultracode).toBe(true);
    expect(parsed.owner).toEqual({ kind: "team", teamId: "team-1" });
    expect(parsed.epic).toEqual(epicLight);
  });

  it("states an opening that omits the key as false", () => {
    const raw = request(true);
    const { ultracode: _omitted, ...settings } =
      raw.chat.initialMessage.settings;
    const parsed = epicCreateV14.requestSchema.parse({
      ...raw,
      chat: {
        ...raw.chat,
        initialMessage: { ...raw.chat.initialMessage, settings },
      },
    });
    expect(parsed.chat?.initialMessage?.settings.ultracode).toBe(false);
  });

  it("is dropped by a 1.3 request, and upgrading that request yields false with the owner kept", () => {
    const old = epicCreateV13.requestSchema.parse(request(true));
    expect(hasUltracode(old.chat?.initialMessage?.settings)).toBe(false);

    const upgraded = epicCreateUpgradeV13ToV14.upgradeRequest(old);
    expect(upgraded.chat?.initialMessage?.settings.ultracode).toBe(false);
    expect(upgraded.owner).toEqual({ kind: "team", teamId: "team-1" });
  });
});
