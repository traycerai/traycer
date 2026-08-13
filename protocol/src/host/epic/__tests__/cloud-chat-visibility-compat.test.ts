import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import {
  setChatSharingDefaultRequestSchema,
  setChatSharingDefaultResponseSchema,
  setCloudChatVisibilityRequestSchema,
  setCloudChatVisibilityResponseSchema,
  type CloudChatSummary,
} from "@traycer/protocol/host/epic/cloud-chat";

/**
 * `epic.setCloudChatVisibility` and `epic.setChatSharingDefault` are new
 * ADDITIVE unary methods on the optional-capabilities channel. Entering the
 * released floor would be handshake-fatal for every peer that shipped before
 * these names existed (same rule as the five cloud-chat reads and
 * `epic.setChatArchived`).
 */

const VISIBILITY_METHODS = [
  "epic.setCloudChatVisibility",
  "epic.setChatSharingDefault",
] as const;

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

describe("cloud-chat visibility mutations are optional, not floor", () => {
  it.each(VISIBILITY_METHODS)(
    "%s is absent from RELEASED_FLOOR_METHOD_NAMES",
    (method) => {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    },
  );

  it.each(VISIBILITY_METHODS)(
    "%s is absent from the guarded released-method-name fixture",
    (method) => {
      expect(releasedMethodNames).not.toContain(method);
    },
  );

  it.each(VISIBILITY_METHODS)(
    "%s advertises on the optional manifest at 1.0, not the floor manifest",
    (method) => {
      const split = splitConnectionManifest(
        hostRpcRegistry,
        RELEASED_FLOOR_METHOD_NAMES,
      );
      expect(split.optionalManifest[method]).toEqual({
        major: 1,
        minor: 0,
      });
      expect(split.manifest[method]).toBeUndefined();
    },
  );

  it.each(VISIBILITY_METHODS)(
    "%s declares an explicit degrade strategy for missing-peer behavior",
    (method) => {
      expect(Object.hasOwn(hostRpcRegistry[method], "degrade")).toBe(true);
    },
  );
});

describe("setCloudChatVisibilityRequestSchema", () => {
  const base = {
    taskId: "task-1",
    chatId: "chat-1",
    visibility: "private" as const,
  };

  it("accepts a well-formed private request", () => {
    expect(setCloudChatVisibilityRequestSchema.safeParse(base).success).toBe(
      true,
    );
  });

  it("accepts a well-formed task request", () => {
    expect(
      setCloudChatVisibilityRequestSchema.safeParse({
        ...base,
        visibility: "task",
      }).success,
    ).toBe(true);
  });

  it("rejects a missing visibility", () => {
    expect(
      setCloudChatVisibilityRequestSchema.safeParse({
        taskId: "task-1",
        chatId: "chat-1",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown visibility", () => {
    expect(
      setCloudChatVisibilityRequestSchema.safeParse({
        ...base,
        visibility: "public",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing taskId (cloud-chat convention, not epicId)", () => {
    expect(
      setCloudChatVisibilityRequestSchema.safeParse({
        chatId: "chat-1",
        visibility: "private",
      }).success,
    ).toBe(false);
  });

  it("does not accept epicId in place of taskId", () => {
    expect(
      setCloudChatVisibilityRequestSchema.safeParse({
        epicId: "epic-1",
        chatId: "chat-1",
        visibility: "private",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing chatId", () => {
    expect(
      setCloudChatVisibilityRequestSchema.safeParse({
        taskId: "task-1",
        visibility: "private",
      }).success,
    ).toBe(false);
  });
});

describe("setCloudChatVisibilityResponseSchema", () => {
  it("accepts an updated cloud-chat summary", () => {
    expect(
      setCloudChatVisibilityResponseSchema.safeParse({ chat: SUMMARY }).success,
    ).toBe(true);
  });

  it("rejects a missing chat", () => {
    expect(setCloudChatVisibilityResponseSchema.safeParse({}).success).toBe(
      false,
    );
  });
});

describe("setChatSharingDefaultRequestSchema", () => {
  const base = {
    taskId: "task-1",
    defaultVisibility: "private" as const,
    applyToExisting: true,
  };

  it("accepts a well-formed request that applies to existing chats", () => {
    expect(setChatSharingDefaultRequestSchema.safeParse(base).success).toBe(
      true,
    );
  });

  it("accepts applyToExisting: false", () => {
    expect(
      setChatSharingDefaultRequestSchema.safeParse({
        ...base,
        applyToExisting: false,
      }).success,
    ).toBe(true);
  });

  it("rejects a missing applyToExisting", () => {
    expect(
      setChatSharingDefaultRequestSchema.safeParse({
        taskId: "task-1",
        defaultVisibility: "private",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing defaultVisibility", () => {
    expect(
      setChatSharingDefaultRequestSchema.safeParse({
        taskId: "task-1",
        applyToExisting: true,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown defaultVisibility", () => {
    expect(
      setChatSharingDefaultRequestSchema.safeParse({
        ...base,
        defaultVisibility: "public",
      }).success,
    ).toBe(false);
  });

  it("does not accept epicId in place of taskId", () => {
    expect(
      setChatSharingDefaultRequestSchema.safeParse({
        epicId: "epic-1",
        defaultVisibility: "private",
        applyToExisting: true,
      }).success,
    ).toBe(false);
  });
});

describe("setChatSharingDefaultResponseSchema", () => {
  it("accepts a non-negative updatedCount", () => {
    expect(
      setChatSharingDefaultResponseSchema.safeParse({ updatedCount: 0 })
        .success,
    ).toBe(true);
    expect(
      setChatSharingDefaultResponseSchema.safeParse({ updatedCount: 3 })
        .success,
    ).toBe(true);
  });

  it("rejects a negative updatedCount", () => {
    expect(
      setChatSharingDefaultResponseSchema.safeParse({ updatedCount: -1 })
        .success,
    ).toBe(false);
  });

  it("rejects a missing updatedCount", () => {
    expect(setChatSharingDefaultResponseSchema.safeParse({}).success).toBe(
      false,
    );
  });
});
