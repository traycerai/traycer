/**
 * `identityId` on the create request lines (Codex bot finding 37).
 *
 * The released `epic.create@1.0`/`@1.1` and `epic.createChat@1.0`/`@1.1`
 * request schemas embed the initial-message settings tuple, and `createChat`
 * additionally carries a fork `settings` tuple at the top level. Both must
 * stay FROZEN without `identityId`: `prepareRequestPayload` strips a newer
 * client's request by re-parsing it through the older minor's own request
 * schema, so a key on the schema a released line binds is a key that reaches a
 * `host-v1.3.1` peer that never negotiated it. The field arrives on `@1.2` of
 * each method, and a `@1.1` caller is upgraded with the honest `null`.
 *
 * Pinned off `hostRpcRegistry`, never the imported symbols, so a later edit
 * that re-points a released line at a laxer schema fails here rather than in
 * production.
 */
import { describe, expect, it } from "vitest";
import { upgradeRequestToVersion } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CreateChatRequestV11,
  CreateChatRequestV12,
  CreateEpicRequest,
  CreateEpicRequestV12,
} from "@traycer/protocol/host/epic/unary-schemas";

const V11 = { major: 1, minor: 1 } as const;
const V12 = { major: 1, minor: 2 } as const;

const createLine = hostRpcRegistry["epic.create"][1];
const createChatLine = hostRpcRegistry["epic.createChat"][1];

const SETTINGS_PRE_IDENTITY = {
  harnessId: "claude" as const,
  model: "claude-sonnet-4",
  permissionMode: "full_access" as const,
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular" as const,
  profileId: null,
};

const SETTINGS_WITH_IDENTITY = {
  ...SETTINGS_PRE_IDENTITY,
  identityId: "identity_1",
};

const INITIAL_MESSAGE_V12 = {
  messageId: "message-1",
  clientActionId: "action-1",
  content: { type: "doc", content: [] },
  sender: { type: "user" as const, userId: "user-1" },
  settings: SETTINGS_WITH_IDENTITY,
  accountContext: { type: "PERSONAL" as const },
  attachmentsByHash: false,
  sentFromHostId: "host-2",
};

const EPIC_LIGHT = {
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

const CREATE_V12: CreateEpicRequestV12 = {
  epic: EPIC_LIGHT,
  repoIdentifiers: [],
  workspaces: [],
  chat: {
    chatId: "chat-1",
    parentId: null,
    hostId: "host-1",
    title: "Chat",
    worktreeIntent: null,
    initialMessage: INITIAL_MESSAGE_V12,
  },
};

const CREATE_CHAT_V12: CreateChatRequestV12 = {
  epicId: "epic-1",
  parentId: null,
  hostId: "host-1",
  title: "Chat",
  chatId: "chat-1",
  settings: SETTINGS_WITH_IDENTITY,
  initialMessage: INITIAL_MESSAGE_V12,
};

describe("epic.create released request lines are frozen without identityId", () => {
  it.each([
    { minor: 0, schema: createLine.versions[0].contract.requestSchema },
    { minor: 1, schema: createLine.versions[1].contract.requestSchema },
  ])(
    "@1.$minor strips identityId from the folded chat's initial-message settings",
    ({ schema }) => {
      const stripped = schema.parse(CREATE_V12);
      expect(stripped.chat?.initialMessage?.settings).toEqual(
        SETTINGS_PRE_IDENTITY,
      );
      expect(stripped.chat?.initialMessage?.settings).not.toHaveProperty(
        "identityId",
      );
    },
  );

  it("@1.2 carries it, and the stock identity round-trips as null", () => {
    const schema = createLine.versions[2].contract.requestSchema;
    expect(schema.parse(CREATE_V12).chat?.initialMessage?.settings).toEqual(
      SETTINGS_WITH_IDENTITY,
    );
    const stock: CreateEpicRequestV12 = {
      ...CREATE_V12,
      chat: {
        ...CREATE_V12.chat,
        chatId: "chat-1",
        parentId: null,
        hostId: "host-1",
        title: "Chat",
        worktreeIntent: null,
        initialMessage: {
          ...INITIAL_MESSAGE_V12,
          settings: { ...SETTINGS_PRE_IDENTITY, identityId: null },
        },
      },
    };
    expect(
      schema.parse(stock).chat?.initialMessage?.settings.identityId,
    ).toBeNull();
  });

  it("upgrades a @1.1 request with identityId: null on the initial message", () => {
    const request: CreateEpicRequest =
      createLine.versions[1].contract.requestSchema.parse(CREATE_V12);
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["epic.create"],
      V11,
      V12,
      request,
    );
    expect(upgraded.chat?.initialMessage?.settings).toEqual({
      ...SETTINGS_PRE_IDENTITY,
      identityId: null,
    });
    expect(upgraded.chat?.initialMessage?.sentFromHostId).toBeNull();
    expect(
      createLine.versions[2].contract.requestSchema.safeParse(upgraded).success,
    ).toBe(true);
  });
});

describe("epic.createChat released request lines are frozen without identityId", () => {
  it.each([
    { minor: 0, schema: createChatLine.versions[0].contract.requestSchema },
    { minor: 1, schema: createChatLine.versions[1].contract.requestSchema },
  ])(
    "@1.$minor strips identityId from both the fork settings and the initial message",
    ({ schema }) => {
      const stripped = schema.parse(CREATE_CHAT_V12);
      expect(stripped.settings).toEqual(SETTINGS_PRE_IDENTITY);
      expect(stripped.settings).not.toHaveProperty("identityId");
      expect(stripped.initialMessage?.settings).toEqual(SETTINGS_PRE_IDENTITY);
      expect(stripped.initialMessage?.settings).not.toHaveProperty(
        "identityId",
      );
    },
  );

  it("@1.2 carries it on both tuples", () => {
    const parsed =
      createChatLine.versions[2].contract.requestSchema.parse(CREATE_CHAT_V12);
    expect(parsed.settings).toEqual(SETTINGS_WITH_IDENTITY);
    expect(parsed.initialMessage?.settings).toEqual(SETTINGS_WITH_IDENTITY);
  });

  it("upgrades a @1.1 request with identityId: null on both tuples", () => {
    const request: CreateChatRequestV11 =
      createChatLine.versions[1].contract.requestSchema.parse(CREATE_CHAT_V12);
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["epic.createChat"],
      V11,
      V12,
      request,
    );
    expect(upgraded.settings).toEqual({
      ...SETTINGS_PRE_IDENTITY,
      identityId: null,
    });
    expect(upgraded.initialMessage?.settings).toEqual({
      ...SETTINGS_PRE_IDENTITY,
      identityId: null,
    });
    expect(upgraded.initialMessage?.sentFromHostId).toBeNull();
    expect(
      createChatLine.versions[2].contract.requestSchema.safeParse(upgraded)
        .success,
    ).toBe(true);
  });

  it("leaves an absent fork settings tuple absent through the upgrade", () => {
    const request: CreateChatRequestV11 = {
      epicId: "epic-1",
      parentId: null,
      hostId: "host-1",
      title: "Chat",
      chatId: "chat-1",
    };
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["epic.createChat"],
      V11,
      V12,
      request,
    );
    expect(upgraded.settings).toBeUndefined();
    expect(upgraded.initialMessage).toBeUndefined();
    expect(
      createChatLine.versions[2].contract.requestSchema.safeParse(upgraded)
        .success,
    ).toBe(true);
  });
});
