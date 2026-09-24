/**
 * The record-plane chat row states its `kind`, so a list fed by the record
 * plane can tell an evolution chat from a conversation while it runs.
 *
 * The field lives on the unreleased rows only - `chatRecordSummaryV12Schema`
 * (`epic.listChatRecords@1.2/1.3`) and `chatRecordSummaryStreamV13Schema`
 * (`host.chatRecords.subscribe@1.3/1.4`). The released lines (`@1.1` and
 * `@1.2` respectively) stay frozen without it, and an answer upgraded from
 * one of them is a conversation: evolution chats exist only on hosts that
 * speak the minors carrying the field.
 */
import { describe, expect, it } from "vitest";
import { epicListChatRecordsUpgradeV11ToV12 } from "@traycer/protocol/host/epic/contracts";
import {
  chatRecordSummaryStreamV13Schema,
  chatRecordSummaryV11Schema,
  chatRecordSummaryV12Schema,
  hostChatRecordsSubscribeServerFrameSchemaV12,
  hostChatRecordsSubscribeServerFrameSchemaV14,
  listChatRecordsResponseV11Schema,
} from "@traycer/protocol/host/epic/chat-records";

const ROW = {
  chatId: "chat-1",
  ownerUserId: "user-1",
  originHostId: "host-1",
  title: "Evolve",
  isTitleEditedByUser: false,
  parentChatId: null,
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  archivedAt: null,
  runSettingsSummary: "claude",
  revision: 1,
  visibility: "private",
  origin: "own",
} as const;

const LIST_ROW = { ...ROW, docResident: false } as const;

describe.each([
  ["epic.listChatRecords@1.2/1.3 row", chatRecordSummaryV12Schema, LIST_ROW],
  [
    "host.chatRecords.subscribe@1.3/1.4 row",
    chatRecordSummaryStreamV13Schema,
    ROW,
  ],
] as const)("%s", (_name, schema, row) => {
  it("defaults an unstated kind to conversation", () => {
    expect(schema.parse(row).kind).toBe("conversation");
  });

  it("carries an evolution chat's kind", () => {
    expect(schema.parse({ ...row, kind: "evolution" }).kind).toBe("evolution");
  });

  it("refuses an unknown kind", () => {
    expect(schema.safeParse({ ...row, kind: "other" }).success).toBe(false);
  });
});

describe("the released lines stay frozen", () => {
  it("epic.listChatRecords@1.1 strips a kind", () => {
    expect(
      chatRecordSummaryV11Schema.parse({ ...LIST_ROW, kind: "evolution" }),
    ).not.toHaveProperty("kind");
  });

  it("host.chatRecords.subscribe@1.2 strips a kind", () => {
    const frame = hostChatRecordsSubscribeServerFrameSchemaV12.parse({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      revision: 1,
      record: { ...ROW, kind: "evolution" },
    });
    if (frame.kind !== "upsert") throw new Error("expected an upsert");
    expect(frame.record).not.toHaveProperty("kind");
  });
});

describe("epic.listChatRecords v1.1 → v1.2 upgrade", () => {
  it("states every row of an older host as a conversation", () => {
    const response = listChatRecordsResponseV11Schema.parse({
      chats: [LIST_ROW],
    });
    expect(
      epicListChatRecordsUpgradeV11ToV12.upgradeResponse(response),
    ).toEqual({ chats: [{ ...LIST_ROW, kind: "conversation" }] });
  });
});

describe("host.chatRecords.subscribe@1.4 upsert", () => {
  it("passes an evolution chat's kind through", () => {
    const frame = hostChatRecordsSubscribeServerFrameSchemaV14.parse({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      revision: 1,
      listRevision: { epoch: "epoch-1", revision: 1 },
      record: { ...ROW, kind: "evolution" },
    });
    if (frame.kind !== "upsert") throw new Error("expected an upsert");
    expect(frame.record.kind).toBe("evolution");
  });
});
