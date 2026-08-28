import { describe, expect, it } from "vitest";
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
