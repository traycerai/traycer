import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  chatRecordSummarySchema,
  hostChatRecordsSubscribeClientFrameSchemaV10,
  hostChatRecordsSubscribeOpenRequestSchemaV10,
  hostChatRecordsSubscribeServerFrameSchemaV10,
  hostChatRecordsSubscribeV10,
  listChatRecordsResponseSchema,
} from "@traycer/protocol/host/epic/chat-records";

/**
 * `host.chatRecords.subscribe@1.0` contract fixtures, plus the record-row
 * facts the record layer depends on: the revision/visibility/origin triple,
 * the archived PAIR (boolean for every row, timestamp only for own rows), and
 * the optional-method degrade that leaves the `epic.listChatRecords` poll as
 * the client's whole story on an older host.
 */

const METHOD = "host.chatRecords.subscribe";

const OWN_ROW = {
  chatId: "chat-1",
  ownerUserId: "user-1",
  originHostId: "host-1",
  title: "Protocol layer",
  isTitleEditedByUser: true,
  parentChatId: null,
  createdAt: 1_753_000_000_000,
  updatedAt: 1_753_000_100_000,
  archived: false,
  archivedAt: null,
  runSettingsSummary: "claude",
  revision: 7,
  visibility: "private",
  origin: "own",
} as const;

const FOREIGN_ARCHIVED_ROW = {
  ...OWN_ROW,
  chatId: "chat-2",
  ownerUserId: "user-2",
  originHostId: "host-2",
  // The cloud row carries a boolean and no timestamp, so a foreign archived
  // row is exactly this: archived, with nothing to display a time from.
  archived: true,
  archivedAt: null,
  visibility: "task",
  origin: "foreign",
} as const;

describe("chat record row", () => {
  it("accepts an own row and a foreign archived replica through one shape", () => {
    expect(chatRecordSummarySchema.parse(OWN_ROW)).toEqual(OWN_ROW);
    expect(chatRecordSummarySchema.parse(FOREIGN_ARCHIVED_ROW)).toEqual(
      FOREIGN_ARCHIVED_ROW,
    );
    expect(
      listChatRecordsResponseSchema.parse({
        chats: [OWN_ROW, FOREIGN_ARCHIVED_ROW],
      }).chats,
    ).toHaveLength(2);
  });

  it("carries archived state independently of the archive timestamp", () => {
    // The regression this pair exists to stop: deriving archived-ness from
    // `archivedAt` reads every foreign archived chat as active.
    expect(FOREIGN_ARCHIVED_ROW.archivedAt).toBeNull();
    expect(chatRecordSummarySchema.parse(FOREIGN_ARCHIVED_ROW).archived).toBe(
      true,
    );
    expect(
      chatRecordSummarySchema.safeParse({
        ...OWN_ROW,
        archived: true,
        archivedAt: 1_753_000_200_000,
      }).success,
    ).toBe(true);
  });

  it("speaks the server's visibility vocabulary and nothing else", () => {
    for (const visibility of ["private", "task"]) {
      expect(
        chatRecordSummarySchema.safeParse({ ...OWN_ROW, visibility }).success,
      ).toBe(true);
    }
    expect(
      chatRecordSummarySchema.safeParse({ ...OWN_ROW, visibility: "shared" })
        .success,
    ).toBe(false);
    expect(
      chatRecordSummarySchema.safeParse({ ...OWN_ROW, visibility: "public" })
        .success,
    ).toBe(false);
  });

  it("requires a non-negative integer revision and a closed origin", () => {
    expect(
      chatRecordSummarySchema.safeParse({ ...OWN_ROW, revision: -1 }).success,
    ).toBe(false);
    expect(
      chatRecordSummarySchema.safeParse({ ...OWN_ROW, revision: 1.5 }).success,
    ).toBe(false);
    expect(
      chatRecordSummarySchema.safeParse({ ...OWN_ROW, revision: 0 }).success,
    ).toBe(true);
    expect(
      chatRecordSummarySchema.safeParse({ ...OWN_ROW, origin: "replica" })
        .success,
    ).toBe(false);
  });
});

describe("host.chatRecords.subscribe@1.0 contract", () => {
  it("declares the method at 1.0 and the registry advertises the latest minor", () => {
    expect(hostChatRecordsSubscribeV10.method).toBe(METHOD);
    expect(hostChatRecordsSubscribeV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    // The manifest names the newest installed minor - @1.1 since the
    // terminal-agent delta frames joined the stream. @1.0 stays installed
    // beneath it for clients that negotiated the frozen set.
    expect(buildStreamManifest(hostStreamRpcRegistry)[METHOD]).toEqual({
      major: 1,
      minor: 1,
    });
  });

  it("stays out of the unary released floor", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(METHOD);
  });

  it("opens host-scoped, with no epic and no resume cursor at 1.0", () => {
    expect(hostChatRecordsSubscribeOpenRequestSchemaV10.parse({})).toEqual({});
    expect(
      Object.keys(hostChatRecordsSubscribeOpenRequestSchemaV10.shape),
    ).toEqual([]);
  });
});

describe("host.chatRecords.subscribe@1.0 frames", () => {
  it("parses an upsert whose envelope revision matches its row", () => {
    const frame = {
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: OWN_ROW.chatId,
      revision: OWN_ROW.revision,
      record: OWN_ROW,
    } as const;

    const parsed = hostChatRecordsSubscribeServerFrameSchemaV10.parse(frame);
    expect(parsed).toEqual(frame);
    if (parsed.kind === "upsert") {
      expect(parsed.revision).toBe(parsed.record.revision);
    }
  });

  it("rejects an upsert whose envelope addresses a different chat than its row", () => {
    // A mismatched envelope is addressing one chat while carrying another's
    // row - whichever field a consumer read would decide which chat it
    // corrupts, so the contract refuses the frame outright.
    const result = hostChatRecordsSubscribeServerFrameSchemaV10.safeParse({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "some-other-chat",
      revision: OWN_ROW.revision,
      record: OWN_ROW,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["chatId"] }),
      ]);
    }
  });

  it("rejects an upsert whose envelope revision disagrees with its row's", () => {
    const result = hostChatRecordsSubscribeServerFrameSchemaV10.safeParse({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: OWN_ROW.chatId,
      revision: OWN_ROW.revision + 1,
      record: OWN_ROW,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["revision"] }),
      ]);
    }
  });

  it("names the epic on every delta, because the stream is host-scoped", () => {
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV10.safeParse({
        kind: "upsert",
        hasBinaryPayload: false,
        chatId: OWN_ROW.chatId,
        revision: OWN_ROW.revision,
        record: OWN_ROW,
      }).success,
    ).toBe(false);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV10.safeParse({
        kind: "remove",
        hasBinaryPayload: false,
        chatId: OWN_ROW.chatId,
        reason: "deleted",
      }).success,
    ).toBe(false);
  });

  it("distinguishes deletion from revocation, and carries no revision on either", () => {
    for (const reason of ["deleted", "revoked"]) {
      const parsed = hostChatRecordsSubscribeServerFrameSchemaV10.parse({
        kind: "remove",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: OWN_ROW.chatId,
        reason,
      });
      expect(parsed).not.toHaveProperty("revision");
      if (parsed.kind === "remove") {
        expect(parsed.reason).toBe(reason);
      }
    }
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV10.safeParse({
        kind: "remove",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: OWN_ROW.chatId,
        reason: "unshared",
      }).success,
    ).toBe(false);
  });

  it("carries a keepalive pair and no other frame kinds at 1.0", () => {
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV10.parse({
        kind: "pong",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("pong");
    expect(
      hostChatRecordsSubscribeClientFrameSchemaV10.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }).kind,
    ).toBe("ping");
    // No `snapshot`: `epic.listChatRecords` is the snapshot, and a second one
    // on this wire would be a shape the two read paths could disagree about.
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        chats: [OWN_ROW],
      }).success,
    ).toBe(false);
  });
});

describe("host.chatRecords.subscribe@1.0 degrades against an older host", () => {
  it("fails only this method's subscribe, leaving every other stream method compatible", () => {
    const currentManifest = buildStreamManifest(hostStreamRpcRegistry);
    const olderHostManifest = Object.fromEntries(
      Object.entries(currentManifest).filter(([method]) => method !== METHOD),
    );

    const records = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      currentManifest,
      olderHostManifest,
      "client",
      METHOD,
    );
    expect(records.ok).toBe(false);
    if (!records.ok) {
      expect(records.details.incompatibleMethods).toEqual([
        expect.objectContaining({ method: METHOD }),
      ]);
    }

    for (const method of [
      "epic.subscribe",
      "chat.subscribe",
      "host.communicationGraph.subscribe",
    ]) {
      expect(
        checkStreamMethodCompatibility(
          hostStreamRpcRegistry,
          currentManifest,
          olderHostManifest,
          "client",
          method,
        ).ok,
      ).toBe(true);
    }
  });
});
