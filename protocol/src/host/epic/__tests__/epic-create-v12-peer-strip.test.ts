import { describe, expect, it } from "vitest";
import {
  epicCreateChatV10,
  epicCreateChatV11,
  epicCreateV10,
  epicCreateV11,
} from "@traycer/protocol/host/epic/contracts";
import type {
  CreateChatRequestV12,
  CreateEpicRequestV12,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * `prepareRequestPayload`'s strip mechanism (`ws-rpc-client.ts`) is "parse the
 * caller's params against the OLDER minor's own request schema". This pins
 * that mechanism at the schema level for `epic.create` and `epic.createChat`:
 * a `@1.2` request carrying both new fields, parsed by an older minor's
 * request schema, comes back WITHOUT either key, with everything else intact.
 */

/**
 * `serviceTier` and `profileId` are `.default(null)` on `chatRunSettingsSchema`,
 * and `z.infer` is the OUTPUT type - so a default makes the key REQUIRED on
 * every value typed as the request, even though `parse` would have filled it.
 * Stated here rather than omitted: these fixtures are typed as the request, so
 * leaving them out type-checks nowhere while still passing at runtime.
 *
 * `identityId` is a `@1.2` key on the settings leaf, so the released lines
 * strip it with the two fields this suite is about - `strippedSettings` is
 * what an older minor's schema hands back. `epic-create-identity-strip.test.ts`
 * pins that leaf on its own.
 */
const strippedSettings = {
  harnessId: "codex" as const,
  model: "gpt-5.4",
  permissionMode: "supervised" as const,
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
};
const settings = { ...strippedSettings, identityId: null };

const initialMessageV12 = {
  messageId: "message-1",
  clientActionId: "action-1",
  content: { type: "doc", content: [] },
  sender: { type: "user" as const, userId: "user-1" },
  settings,
  accountContext: { type: "PERSONAL" as const },
  attachmentsByHash: true,
  sentFromHostId: "host-2",
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

const seedV12 = {
  chatId: "chat-1",
  parentId: null,
  hostId: "host-1",
  title: "Chat",
  worktreeIntent: null,
  initialMessage: initialMessageV12,
  deferWorktreeProvisioning: true,
};

const epicCreateV12Request: CreateEpicRequestV12 = {
  epic: epicLight,
  repoIdentifiers: [],
  workspaces: [],
  chat: seedV12,
};

const createChatV12Request: CreateChatRequestV12 = {
  epicId: "epic-1",
  parentId: null,
  hostId: "host-1",
  title: "Chat",
  chatId: "chat-1",
  initialMessage: initialMessageV12,
  deferWorktreeProvisioning: true,
};

describe("epic.create@1.2 request strips to an older minor's own schema", () => {
  it("epicCreateV11.requestSchema strips both new fields, keeping everything else", () => {
    const stripped = epicCreateV11.requestSchema.parse(epicCreateV12Request);
    expect(stripped.chat).not.toBeNull();
    expect(stripped.chat).not.toHaveProperty("deferWorktreeProvisioning");
    expect(stripped.chat?.initialMessage).not.toHaveProperty(
      "attachmentsByHash",
    );
    expect(stripped.chat?.initialMessage).not.toHaveProperty("sentFromHostId");
    expect(stripped).toMatchObject({
      epic: epicLight,
      repoIdentifiers: [],
      workspaces: [],
      chat: {
        chatId: "chat-1",
        parentId: null,
        hostId: "host-1",
        title: "Chat",
        worktreeIntent: null,
        initialMessage: {
          messageId: "message-1",
          clientActionId: "action-1",
          sender: { type: "user", userId: "user-1" },
          settings: strippedSettings,
          accountContext: { type: "PERSONAL" },
        },
      },
    });
    expect(stripped.chat?.initialMessage?.settings).not.toHaveProperty(
      "identityId",
    );
  });

  it("epicCreateV10.requestSchema strips both new fields too", () => {
    const stripped = epicCreateV10.requestSchema.parse(epicCreateV12Request);
    expect(stripped.chat).not.toHaveProperty("deferWorktreeProvisioning");
    expect(stripped.chat?.initialMessage).not.toHaveProperty(
      "attachmentsByHash",
    );
    expect(stripped.chat?.initialMessage).not.toHaveProperty("sentFromHostId");
    expect(stripped.chat?.chatId).toBe("chat-1");
  });
});

describe("epic.createChat@1.2 request strips to an older minor's own schema", () => {
  it("epicCreateChatV11.requestSchema strips both new fields, keeping everything else", () => {
    const stripped =
      epicCreateChatV11.requestSchema.parse(createChatV12Request);
    expect(stripped).not.toHaveProperty("deferWorktreeProvisioning");
    expect(stripped.initialMessage).not.toHaveProperty("attachmentsByHash");
    expect(stripped.initialMessage).not.toHaveProperty("sentFromHostId");
    expect(stripped).toMatchObject({
      epicId: "epic-1",
      parentId: null,
      hostId: "host-1",
      title: "Chat",
      chatId: "chat-1",
      initialMessage: {
        messageId: "message-1",
        clientActionId: "action-1",
        sender: { type: "user", userId: "user-1" },
        settings: strippedSettings,
        accountContext: { type: "PERSONAL" },
      },
    });
    expect(stripped.initialMessage?.settings).not.toHaveProperty("identityId");
  });

  it("epicCreateChatV10.requestSchema strips both new fields too", () => {
    const stripped =
      epicCreateChatV10.requestSchema.parse(createChatV12Request);
    expect(stripped).not.toHaveProperty("deferWorktreeProvisioning");
    expect(stripped.initialMessage).not.toHaveProperty("attachmentsByHash");
    expect(stripped.initialMessage).not.toHaveProperty("sentFromHostId");
    expect(stripped.chatId).toBe("chat-1");
  });
});
