import { describe, expect, it } from "vitest";
import { hostRpcRegistry, hostStreamRpcRegistry } from "../../registry";
import {
  resolveCloudChatHeadResponseSchema,
  type CloudChatSummary,
} from "../cloud-chat";

/**
 * The `chat`/`outcome.status` cross-field invariant is part of the wire
 * contract, not a doc comment: `chat` is null exactly when the outcome is
 * "missing". Every consumer branches on the status while reading `chat`, so a
 * response that violates the pairing must be refused at the schema - the two
 * fields validating independently is precisely what these rows pin against.
 */

const SUMMARY: CloudChatSummary = {
  identity: {
    taskId: "11111111-1111-4111-8111-111111111111",
    chatId: "22222222-2222-4222-8222-222222222222",
    ownerUserId: "user-1",
  },
  ownerHostId: "host-1",
  createdAt: 100,
  visibility: "task",
  title: "Walkthrough",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 300,
  headSha256: null,
  publishedAt: null,
  throughRecordSeq: null,
  isOwnedByViewer: true,
};

describe("resolveCloudChatHeadResponseSchema chat/outcome invariant", () => {
  it("accepts a missing outcome with a null chat", () => {
    const parsed = resolveCloudChatHeadResponseSchema.safeParse({
      chat: null,
      outcome: { status: "missing" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a resolved outcome with its summary", () => {
    const parsed = resolveCloudChatHeadResponseSchema.safeParse({
      chat: SUMMARY,
      outcome: { status: "unpublished" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing outcome that smuggles a summary", () => {
    const parsed = resolveCloudChatHeadResponseSchema.safeParse({
      chat: SUMMARY,
      outcome: { status: "missing" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a resolved outcome with no summary", () => {
    const parsed = resolveCloudChatHeadResponseSchema.safeParse({
      chat: null,
      outcome: { status: "unpublished" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("cloud chat creator attribution on the 1.1 read surfaces", () => {
  const creatorSummary: CloudChatSummary = {
    ...SUMMARY,
    identity: { ...SUMMARY.identity, ownerUserId: "owner-2" },
    isOwnedByViewer: false,
    creatorUserId: "creator-1",
  };
  const nullCreatorSummary: CloudChatSummary = {
    ...SUMMARY,
    creatorUserId: null,
  };

  it("retains creator, explicit null, and legacy omission on the registered list", () => {
    const line = hostRpcRegistry["epic.listCloudChats"][1];
    const v11 = line.versions[1].contract;
    const v10 = line.versions[0].contract;
    const response = {
      chats: [creatorSummary, nullCreatorSummary, SUMMARY],
    };

    const current = v11.responseSchema.parse(response);
    expect(line.latestMinor).toBe(1);
    expect(current.chats.map((chat) => chat.creatorUserId)).toEqual([
      "creator-1",
      null,
      undefined,
    ]);
    expect(current.chats[2]).not.toHaveProperty("creatorUserId");
    expect(current.chats[0]).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });

    const released = v10.responseSchema.parse(response);
    expect(released.chats[0]).not.toHaveProperty("creatorUserId");
    expect(released.chats[0]).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });
  });

  it("retains creator attribution only in the registered 1.1 environment snapshot", () => {
    const line = hostStreamRpcRegistry["environment.chats.subscribe"][1];
    const snapshot = {
      kind: "snapshot",
      hasBinaryPayload: false,
      generation: 1,
      chats: [creatorSummary, nullCreatorSummary, SUMMARY],
    } as const;

    const current = line.versions[1].contract.serverFrameSchema.parse(snapshot);
    expect(current.kind).toBe("snapshot");
    if (current.kind !== "snapshot") {
      throw new Error("Expected an environment chats snapshot");
    }
    expect(current.chats.map((chat) => chat.creatorUserId)).toEqual([
      "creator-1",
      null,
      undefined,
    ]);
    expect(current.chats[2]).not.toHaveProperty("creatorUserId");
    expect(current.chats[0]).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });

    const released =
      line.versions[0].contract.serverFrameSchema.parse(snapshot);
    expect(released.kind).toBe("snapshot");
    if (released.kind !== "snapshot") {
      throw new Error("Expected a released environment chats snapshot");
    }
    expect(released.chats[0]).not.toHaveProperty("creatorUserId");
    expect(released.chats[0]).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });
  });

  it("keeps head resolution on its frozen 1.0 response schema", () => {
    const line = hostRpcRegistry["epic.resolveCloudChatHead"][1];
    const resolved = line.versions[0].contract.responseSchema.parse({
      chat: creatorSummary,
      outcome: { status: "unpublished" },
    });

    expect(line.latestMinor).toBe(1);
    expect(resolved.chat).not.toHaveProperty("creatorUserId");
    expect(resolved.chat).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });
  });

  it("retains creator states on the registered 1.1 resolve with its outcome invariant", () => {
    const line = hostRpcRegistry["epic.resolveCloudChatHead"][1];
    const responseSchema = line.versions[1].contract.responseSchema;
    const responses = [creatorSummary, nullCreatorSummary, SUMMARY].map(
      (chat) =>
        responseSchema.parse({
          chat,
          outcome: { status: "unpublished" },
        }),
    );

    expect(line.latestMinor).toBe(1);
    expect(responses.map((response) => response.chat?.creatorUserId)).toEqual([
      "creator-1",
      null,
      undefined,
    ]);
    expect(responses.map((response) => response.outcome.status)).toEqual([
      "unpublished",
      "unpublished",
      "unpublished",
    ]);
    expect(responses[0].chat).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });
    expect(responses[2].chat).not.toHaveProperty("creatorUserId");
    expect(
      responseSchema.safeParse({
        chat: creatorSummary,
        outcome: { status: "missing" },
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        chat: null,
        outcome: { status: "missing" },
      }).success,
    ).toBe(true);
  });

  it("keeps visibility updates on their frozen 1.0 summary schema", () => {
    const line = hostRpcRegistry["epic.setCloudChatVisibility"][1];
    const response = line.versions[0].contract.responseSchema.parse({
      chat: creatorSummary,
    });

    expect(line.latestMinor).toBe(0);
    expect(response.chat).not.toHaveProperty("creatorUserId");
    expect(response.chat).toMatchObject({
      identity: { ownerUserId: "owner-2" },
      visibility: "task",
      isOwnedByViewer: false,
    });
  });
});
