import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  chatRecordSummarySchema,
  chatRecordSummaryStreamV13Schema,
  chatRecordSummaryV12Schema,
  hostChatRecordsSubscribeClientFrameSchemaV10,
  hostChatRecordsSubscribeOpenRequestSchemaV10,
  hostChatRecordsSubscribeServerFrameSchemaV10,
  hostChatRecordsSubscribeServerFrameSchemaV11,
  hostChatRecordsSubscribeServerFrameSchemaV12,
  hostChatRecordsSubscribeServerFrameSchemaV13,
  hostChatRecordsSubscribeV10,
  listChatRecordsResponseSchema,
  listChatRecordsResponseV12Schema,
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
    // The manifest names the newest installed minor - @1.4 since every record
    // delta grew the LIST revision stamp (and the `tuiUpsert` row the session
    // facet). @1.0 through @1.3 stay installed beneath it for clients that
    // negotiated the frozen sets.
    expect(
      buildStreamManifest(hostStreamRpcRegistry, SERVES_EVERY_INSTALLED_MAJOR)[
        METHOD
      ],
    ).toEqual({
      major: 1,
      minor: 4,
      supportedMajors: [1],
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
    const currentManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
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

describe("host.chatRecords.subscribe@1.2 tuiUpsert frames", () => {
  const ENVELOPE = {
    kind: "tuiUpsert",
    hasBinaryPayload: false,
    epicId: "epic-1",
    tuiAgentId: "tui-1",
    revision: 7,
  } as const;

  const LOCAL_RECORD = {
    tuiAgentId: "tui-1",
    ownerUserId: "user-1",
    hostId: "host-1",
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "An agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 7,
    docResident: false,
    origin: "registry",
  } as const;

  const CLOUD_RECORD = {
    tuiAgentId: "tui-1",
    ownerUserId: "user-1",
    hostId: "host-2",
    harnessId: "claude",
    parentId: null,
    title: "A remote agent",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    revision: 7,
    origin: "cloud",
  } as const;

  it("carries a registry row, exactly as @1.1 did", () => {
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV12.safeParse({
        ...ENVELOPE,
        record: LOCAL_RECORD,
      }).success,
    ).toBe(true);
  });

  it("carries a narrow cloud replica - the phase-2 population", () => {
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV12.safeParse({
        ...ENVELOPE,
        record: CLOUD_RECORD,
      }).success,
    ).toBe(true);
  });

  it("refuses a cloud replica on the frozen @1.1 frame set", () => {
    // The emission gate's reason, stated as a contract fact: a @1.1
    // subscriber agreed to a `tuiUpsert` carrying the full registry row, so
    // handing it a narrow arm would be a frame it cannot parse. The host
    // must never emit one below the negotiated floor.
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV11.safeParse({
        ...ENVELOPE,
        record: CLOUD_RECORD,
      }).success,
    ).toBe(false);
  });

  it("still enforces the envelope invariant across every arm", () => {
    // The envelope addresses and orders the row it carries. A frame where the
    // two disagree corrupts whichever chat the consumer happened to read.
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV12.safeParse({
        ...ENVELOPE,
        record: { ...CLOUD_RECORD, tuiAgentId: "tui-other" },
      }).success,
    ).toBe(false);
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV12.safeParse({
        ...ENVELOPE,
        record: { ...CLOUD_RECORD, revision: 8 },
      }).success,
    ).toBe(false);
  });
});

describe("chat record head stamp (@1.2 list row / @1.3 frames)", () => {
  const HEAD = {
    headSha256: "a".repeat(64),
    throughRecordSeq: 12,
    publishedAt: 1_753_000_200_000,
  } as const;

  const FOREIGN_PUBLISHED_ROW = {
    ...FOREIGN_ARCHIVED_ROW,
    archived: false,
    head: HEAD,
  } as const;

  it("accepts a stamp, an explicit null, and an absent key", () => {
    // The three states the wire distinguishes: a publication to point at, the
    // host's positive "there is none" (own rows, and foreign rows never
    // published), and the older shape an upgraded @1.1 row arrives in.
    expect(
      chatRecordSummaryStreamV13Schema.safeParse(FOREIGN_PUBLISHED_ROW).success,
    ).toBe(true);
    expect(
      chatRecordSummaryStreamV13Schema.safeParse({ ...OWN_ROW, head: null })
        .success,
    ).toBe(true);
    expect(chatRecordSummaryStreamV13Schema.safeParse(OWN_ROW).success).toBe(
      true,
    );
  });

  it("keeps `docResident` off the stream row and required on the list row", () => {
    // The two surfaces' rows DIVERGE here, and the divergence is the point: a
    // delta cannot state the home (a doc-homed chat does produce deltas, via
    // `hydrateLegacyDocSecondary`), so the stream row must not carry the field
    // at all, while the @1.1 list row has carried it since the lane cutover.
    const streamRow = chatRecordSummaryStreamV13Schema.parse(
      FOREIGN_PUBLISHED_ROW,
    );
    expect(streamRow).not.toHaveProperty("docResident");
    expect(
      chatRecordSummaryV12Schema.safeParse(FOREIGN_PUBLISHED_ROW).success,
    ).toBe(false);
    expect(
      chatRecordSummaryV12Schema.safeParse({
        ...FOREIGN_PUBLISHED_ROW,
        docResident: false,
      }).success,
    ).toBe(true);
  });

  it("requires a lowercase hex digest, a non-negative integer seq and a non-negative integer publishedAt", () => {
    for (const head of [
      { ...HEAD, headSha256: "A".repeat(64) },
      { ...HEAD, headSha256: "a".repeat(63) },
      { ...HEAD, throughRecordSeq: -1 },
      { ...HEAD, throughRecordSeq: 1.5 },
      { ...HEAD, publishedAt: -1 },
      { ...HEAD, publishedAt: 1.5 },
    ]) {
      expect(
        chatRecordSummaryStreamV13Schema.safeParse({ ...OWN_ROW, head })
          .success,
      ).toBe(false);
    }
  });

  it("strips the head when an older minor reparses the row", () => {
    // The whole basis on which this ships as a MINOR: the pre-`head` schemas
    // are plain (non-strict) objects, so a @1.0/@1.2 peer drops the key it
    // does not know instead of refusing the row.
    const reparsed = chatRecordSummarySchema.parse(FOREIGN_PUBLISHED_ROW);
    expect(reparsed).not.toHaveProperty("head");

    const frame = {
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: FOREIGN_PUBLISHED_ROW.chatId,
      revision: FOREIGN_PUBLISHED_ROW.revision,
      record: FOREIGN_PUBLISHED_ROW,
    } as const;
    const reparsedFrame =
      hostChatRecordsSubscribeServerFrameSchemaV10.parse(frame);
    expect(reparsedFrame.kind).toBe("upsert");
    if (reparsedFrame.kind === "upsert") {
      expect(reparsedFrame.record).not.toHaveProperty("head");
    }

    // Same fact on the list read, which is the poll that repairs a lost delta.
    expect(
      listChatRecordsResponseSchema.parse({ chats: [FOREIGN_PUBLISHED_ROW] })
        .chats[0],
    ).not.toHaveProperty("head");
  });

  it("carries the head through the @1.3 upsert frame and the @1.2 list", () => {
    const parsed = hostChatRecordsSubscribeServerFrameSchemaV13.parse({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: FOREIGN_PUBLISHED_ROW.chatId,
      revision: FOREIGN_PUBLISHED_ROW.revision,
      record: FOREIGN_PUBLISHED_ROW,
    });
    expect(parsed.kind).toBe("upsert");
    if (parsed.kind === "upsert") {
      expect(parsed.record.head).toEqual(HEAD);
    }

    expect(
      listChatRecordsResponseV12Schema.parse({
        chats: [{ ...FOREIGN_PUBLISHED_ROW, docResident: false }],
      }).chats[0].head,
    ).toEqual(HEAD);
  });

  it("keeps every @1.2 frame kind, tuiUpsert row union included", () => {
    // @1.3 grows one arm's row; it narrows nothing. A @1.2 subscriber's whole
    // frame vocabulary must still parse here.
    for (const frame of [
      {
        kind: "remove",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: OWN_ROW.chatId,
        reason: "revoked",
      },
      { kind: "pong", hasBinaryPayload: false },
      {
        kind: "tuiRemove",
        hasBinaryPayload: false,
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        reason: "deleted",
      },
      // Both arms of the `@1.2` terminal-agent row union, restated by hand on
      // `@1.3`: a wrong restatement of either arm fails here, not in the field.
      {
        kind: "tuiUpsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        revision: 7,
        record: {
          tuiAgentId: "tui-1",
          ownerUserId: "user-1",
          hostId: "host-1",
          harnessId: "claude",
          harnessSessionId: null,
          parentId: null,
          title: "An agent",
          isTitleEditedByUser: false,
          createdAt: 1,
          updatedAt: 2,
          archived: false,
          archivedAt: null,
          workspaceFolders: [],
          workspaceMode: null,
          model: null,
          reasoningEffort: null,
          agentMode: "regular",
          profileId: null,
          terminalAgentArgs: null,
          terminalShellCommand: null,
          terminalShellArgs: null,
          revision: 7,
          docResident: false,
          origin: "registry",
        },
      },
      {
        kind: "tuiUpsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        revision: 7,
        record: {
          tuiAgentId: "tui-1",
          ownerUserId: "user-1",
          hostId: "host-2",
          harnessId: "claude",
          parentId: null,
          title: "A remote agent",
          isTitleEditedByUser: false,
          createdAt: 1,
          updatedAt: 2,
          archived: false,
          revision: 7,
          origin: "cloud",
        },
      },
    ]) {
      expect(
        hostChatRecordsSubscribeServerFrameSchemaV13.safeParse(frame).success,
      ).toBe(true);
    }
  });

  it("still enforces the envelope invariant on the grown row", () => {
    expect(
      hostChatRecordsSubscribeServerFrameSchemaV13.safeParse({
        kind: "upsert",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "some-other-chat",
        revision: FOREIGN_PUBLISHED_ROW.revision,
        record: FOREIGN_PUBLISHED_ROW,
      }).success,
    ).toBe(false);
  });
});
