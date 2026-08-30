import { describe, expect, it } from "vitest";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
  chatSubscribeV16,
  chatSubscribeV18,
  chatSubscribeWindowedClientFrameSchema,
  chatSubscribeWindowedServerFrameSchema,
  chatWindowedSnapshotSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ACCUMULATED_CHANGE_DIGEST_MAX_CHARS,
  chatAccumulatedFileChangeSummarySchema,
  chatIndexChangeSchema,
  chatLoadRangeRequestSchema,
  chatLocateRowResponseSchema,
  chatRangeResponseSchema,
  chatReadAccumulatedFileChangeResponseSchema,
  RANGE_REQUEST_ID_MAX_CHARS,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  chatSchema,
  chatSchemaV16,
} from "@traycer/protocol/persistence/epic/schemas";
import { rowSkeletonEntrySchema } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

// ─── Group 1: the windowed line never carries an unbounded transcript ──────

describe("chatWindowedSnapshotSchema never embeds the transcript", () => {
  it("has no messages/events key on the embedded chat record", () => {
    const chatKeys = Object.keys(chatWindowedSnapshotSchema.shape.chat.shape);

    expect(chatKeys).not.toContain("messages");
    expect(chatKeys).not.toContain("events");
  });

  it("has no messages/events key at the snapshot's own top level", () => {
    // `tail` legitimately carries `messages`/`events` arrays - that is the
    // bounded hydrated window, not the unbounded transcript this guard is
    // about. Scoped to the snapshot's own keys and to `chat`, not to `tail`.
    const topLevelKeys = Object.keys(chatWindowedSnapshotSchema.shape);

    expect(topLevelKeys).not.toContain("messages");
    expect(topLevelKeys).not.toContain("events");
    expect(topLevelKeys).toContain("tail");
  });
});

function baseChatRecord() {
  return {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
  };
}

function baseWindowedSnapshot(): Record<string, unknown> {
  return {
    chat: baseChatRecord(),
    access: { role: "owner", ownerUserId: "user-1", canAct: true },
    queue: { status: "idle", items: [] },
    runStatus: "idle",
    activeTurn: null,
    pendingApprovals: [],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
    accumulatedFileChangeCount: 0,
    transcriptEpoch: 0,
    rowCount: 0,
    // `null` is the bootstrap value - the host holds no index for this
    // subscriber yet and a full skeleton follows - which is what a minimal
    // frame with no rows is.
    indexRevision: null,
    tail: { fromOrdinal: 0, messages: [], events: [] },
    derived: {
      latestAssistantUsage: null,
      pinnedTodo: null,
      pinnedTaskTodoItems: [],
      latestForkableAssistantMessageId: null,
      restorableSetupInterruption: null,
      interviewAnswerability: [],
      latestAssistantAuthFailureTurnKey: null,
      setupCardWindows: [],
    },
  };
}

function windowedSnapshotFrame(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot,
  };
}

describe("chatSubscribeWindowedServerFrameSchema's snapshot variant", () => {
  it("parses a minimal valid bounded snapshot frame", () => {
    const parsed = chatSubscribeWindowedServerFrameSchema.parse(
      windowedSnapshotFrame(baseWindowedSnapshot()),
    );

    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.rowCount).toBe(0);
    expect(parsed.snapshot.tail).toEqual({
      fromOrdinal: 0,
      messages: [],
      events: [],
    });
  });

  it("rejects a frame shaped like a 1.6 (whole-transcript) snapshot", () => {
    const legacyShapedSnapshot = {
      chat: { ...baseChatRecord(), messages: [], events: [] },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      // The field the windowed line actually uses, so this fixture is rejected
      // specifically for missing transcriptEpoch/rowCount/tail/derived - not
      // merely for an unrelated field-name difference.
      accumulatedFileChangeCount: 0,
      // No transcriptEpoch / rowCount / tail / derived - the windowed-only
      // fields a real 1.8 snapshot must carry.
    };

    expect(
      chatSubscribeWindowedServerFrameSchema.safeParse(
        windowedSnapshotFrame(legacyShapedSnapshot),
      ).success,
    ).toBe(false);
  });
});

// ─── Group 2: the 1.6 freeze is real ────────────────────────────────────────

describe("the chat.subscribe@1.6 freeze", () => {
  it("declares schemaVersion 1.6, and the windowed line declares 1.8", () => {
    expect(chatSubscribeV16.schemaVersion).toEqual({ major: 1, minor: 6 });
    expect(chatSubscribeV18.schemaVersion).toEqual({ major: 1, minor: 8 });
  });

  it("strips an unknown key on the frozen 1.6 chat object (canary: bound to an object schema)", () => {
    const frame = {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          parentId: null,
          id: "chat-1",
          userId: "user-1",
          hostId: "host-1",
          title: "Chat",
          createdAt: 1000,
          updatedAt: 1000,
          isTitleEditedByUser: false,
          messages: [],
          // Not a field on chatSchemaV16 - must be stripped, not passed through.
          somethingFromTheFuture: "leak",
        },
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
      },
    };

    const parsed = chatSubscribeV16.serverFrameSchema.parse(frame);
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.chat).not.toHaveProperty("somethingFromTheFuture");
  });

  // The stronger guarantee: `chatSchemaV16` is a HAND-FROZEN copy, not a
  // reference to the live `chatSchema`. If it were a reference, any later
  // field added to `chatSchema` (as `pinnedUserProviderHandle` and
  // `lastDeliveredRolesDigest` were) would silently reach this released wire
  // shape. Written out literally so a future field addition to `chatSchema`
  // must be a DELIBERATE decision about this file, not an accident.
  const CHAT_SCHEMA_V16_FIELDS = [
    "parentId",
    "id",
    "userId",
    "hostId",
    "title",
    "createdAt",
    "updatedAt",
    "isTitleEditedByUser",
    "settings",
    "activeSessionChain",
    "claudePendingWakes",
    "messages",
    "events",
    "archivedAt",
    "pinnedUserProviderHandle",
    "lastDeliveredRolesDigest",
  ].sort();

  it("exposes exactly the field list chat.subscribe@1.6 shipped", () => {
    expect(Object.keys(chatSchemaV16.shape).sort()).toEqual(
      CHAT_SCHEMA_V16_FIELDS,
    );
  });

  // Fields added to the live `chatSchema` AFTER `1.6` shipped.
  //
  // Empty today, and appending to it is the whole point: this is the tripwire
  // that makes a new chat-record field a deliberate decision about the released
  // wire shape rather than something that happens to it. When the assertion
  // below fires, add the new field name HERE - never to
  // `CHAT_SCHEMA_V16_FIELDS`, which is what `1.6` shipped and is finished.
  //
  // Deliberately not a plain equality check against `chatSchema`: an equality
  // that can only ever be "fixed" by deleting it teaches the next person to
  // delete it, and then nothing watches this again.
  const CHAT_SCHEMA_FIELDS_ADDED_AFTER_V16: readonly string[] = [];

  it("accounts for every live chatSchema field as either frozen into 1.6 or explicitly post-1.6", () => {
    const accountedFor = [
      ...CHAT_SCHEMA_V16_FIELDS,
      ...CHAT_SCHEMA_FIELDS_ADDED_AFTER_V16,
    ].sort();

    expect(Object.keys(chatSchema.shape).sort()).toEqual(accountedFor);
  });

  it("never invents a field the live chat record does not have", () => {
    const live = new Set(Object.keys(chatSchema.shape));
    const invented = Object.keys(chatSchemaV16.shape).filter(
      (key) => !live.has(key),
    );

    expect(invented).toEqual([]);
  });
});

// ─── Group 3: the 1.8 frame unions ──────────────────────────────────────────

describe("chatSubscribeWindowedServerFrameSchema's frame kinds", () => {
  const WINDOWED_SERVER_KINDS = [
    // Windowed-only.
    "snapshot",
    "skeletonChunk",
    // The accumulated-change summaries are chunked out of the snapshot for the
    // reason the skeleton never joined it: their count is a property of the
    // chat's HISTORY, not its current state.
    "accumulatedChanges",
    "indexChanged",
    "range",
    // Shared with 1.6.
    "turnStateChanged",
    "managedCommandsChanged",
    "heldUpdatesChanged",
    "actionAck",
    "messageAccepted",
    "queueChanged",
    "approvalRequested",
    "approvalResolved",
    "fileEditApprovalRequested",
    "fileEditApprovalResolved",
    "interviewRequested",
    "interviewAnswered",
    "interviewErrored",
    "eventAppended",
    "restoreStarted",
    "restoreProgress",
    "restoreCompleted",
    "errorNotice",
    "worktreeStateChanged",
    "pong",
    "blockDelta",
  ].sort();

  it("admits exactly this literal list of server frame kinds", () => {
    const actual = chatSubscribeWindowedServerFrameSchema.options
      .map((option) => option.shape.kind.value)
      .sort();

    expect(actual).toEqual(WINDOWED_SERVER_KINDS);
  });
});

describe("chatSubscribeWindowedClientFrameSchema's frame kinds", () => {
  it("admits exactly the 1.6 client union's kinds, plus loadRange and resnapshot", () => {
    const v16ClientKinds = chatSubscribeClientFrameSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const windowedClientKinds = chatSubscribeWindowedClientFrameSchema.options
      .map((option) => option.shape.kind.value)
      .sort();

    const expected = [...v16ClientKinds, "loadRange", "resnapshot"].sort();
    expect(windowedClientKinds).toEqual(expected);

    // Strict superset check spelled out explicitly, not just "same length":
    // every 1.6 kind must individually still be present.
    for (const kind of v16ClientKinds) {
      expect(windowedClientKinds).toContain(kind);
    }
    expect(windowedClientKinds).toContain("loadRange");
    expect(windowedClientKinds).toContain("resnapshot");
  });
});

describe("the 1.6 server union does not admit windowed-only frame kinds", () => {
  it("rejects range, indexChanged, and skeletonChunk kinds", () => {
    // `Set<string>`, not the inferred `Set<"actionAck" | ...>`, and the reason
    // is worth keeping: with the narrow element type the compiler REFUSES
    // `has("range")` outright, because it already knows `1.6` has no such
    // variant. That is the guard holding at the type level - but a test that
    // cannot be written is not a test, and the whole point here is to fail
    // loudly at runtime if someone later widens the union.
    // Read from `chatSubscribeV16.serverFrameSchema`, NOT from the exported
    // live union. They are different objects now, and the contract binds the
    // former - a cold review caught this reading the wrong one, where adding
    // `skeletonChunk` to the frozen union would have left the test green.
    const v16ServerKinds = new Set<string>(
      chatSubscribeV16.serverFrameSchema.options.map(
        (option) => option.shape.kind.value,
      ),
    );

    expect(v16ServerKinds.has("range")).toBe(false);
    expect(v16ServerKinds.has("indexChanged")).toBe(false);
    expect(v16ServerKinds.has("skeletonChunk")).toBe(false);
    expect(v16ServerKinds.has("accumulatedChanges")).toBe(false);
  });

  it("actually rejects a well-formed range frame at parse time, not just at the kind-list level", () => {
    const rangeFrame = {
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "req-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
        events: [],
        reachedStart: true,
        reachedEnd: true,
      },
    };

    expect(
      chatSubscribeV16.serverFrameSchema.safeParse(rangeFrame).success,
    ).toBe(false);
  });

  it("rejects skeletonChunk and indexChanged frames at parse time too", () => {
    // The kind list above is a structural check; these are the runtime half.
    // Only `range` had one, so a frozen union that gained `skeletonChunk`
    // would have passed both.
    const skeletonChunkFrame = {
      kind: "skeletonChunk",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      chunk: { epoch: 0, fromOrdinal: 0, entries: [], isFinal: true },
    };
    const indexChangedFrame = {
      kind: "indexChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      epoch: 1,
      rowCount: 0,
      // The wire field is the ARRAY `changes` (see `chatIndexChangeSchema`'s
      // frame). Spelling it `change` here would make this fixture malformed on
      // its own terms, so the rejection below would prove only that - and it
      // would keep proving it after someone added `indexChanged` to the frozen
      // `1.6` union, which is the one regression this assertion exists to
      // catch.
      changes: [{ type: "reindexed" }],
    };

    expect(
      chatSubscribeV16.serverFrameSchema.safeParse(skeletonChunkFrame).success,
    ).toBe(false);
    expect(
      chatSubscribeV16.serverFrameSchema.safeParse(indexChangedFrame).success,
    ).toBe(false);
  });
});

// ─── Group 4: bounded fields on the wire ────────────────────────────────────

describe("chatLoadRangeRequestSchema bounds", () => {
  function baseRequest() {
    return {
      requestId: "req-1",
      epoch: 0,
      fromOrdinal: 0,
      toOrdinal: 10,
      maxBytes: 1024,
    };
  }

  it("accepts a requestId at the max length", () => {
    const requestId = "x".repeat(RANGE_REQUEST_ID_MAX_CHARS);
    expect(
      chatLoadRangeRequestSchema.safeParse({ ...baseRequest(), requestId })
        .success,
    ).toBe(true);
  });

  it("rejects a requestId longer than RANGE_REQUEST_ID_MAX_CHARS", () => {
    const requestId = "x".repeat(RANGE_REQUEST_ID_MAX_CHARS + 1);
    expect(
      chatLoadRangeRequestSchema.safeParse({ ...baseRequest(), requestId })
        .success,
    ).toBe(false);
  });

  it("rejects a zero maxBytes", () => {
    expect(
      chatLoadRangeRequestSchema.safeParse({ ...baseRequest(), maxBytes: 0 })
        .success,
    ).toBe(false);
  });

  it("rejects a negative maxBytes", () => {
    expect(
      chatLoadRangeRequestSchema.safeParse({ ...baseRequest(), maxBytes: -1 })
        .success,
    ).toBe(false);
  });
});

describe("chatRangeResponseSchema bounds", () => {
  function baseResponse() {
    return {
      requestId: "req-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: [],
      messages: [],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    };
  }

  it("accepts a requestId at the max length", () => {
    const requestId = "x".repeat(RANGE_REQUEST_ID_MAX_CHARS);
    expect(
      chatRangeResponseSchema.safeParse({ ...baseResponse(), requestId })
        .success,
    ).toBe(true);
  });

  it("rejects a requestId longer than RANGE_REQUEST_ID_MAX_CHARS", () => {
    const requestId = "x".repeat(RANGE_REQUEST_ID_MAX_CHARS + 1);
    expect(
      chatRangeResponseSchema.safeParse({ ...baseResponse(), requestId })
        .success,
    ).toBe(false);
  });
});

describe("chatAccumulatedFileChangeSummarySchema's digest bound", () => {
  function baseSummary() {
    return {
      filePath: "src/a.ts",
      operation: "edit" as const,
      diffSource: "snapshot" as const,
      reason: "snapshot" as const,
      undoable: true,
      hasContents: true,
      // `null` is the "nothing to count" case (`diffSource: "none"`), and is
      // deliberately distinct from `{additions: 0, deletions: 0}`, which means
      // the host counted and the file came back unchanged.
      counts: null,
    };
  }

  it("accepts a digest at the max length", () => {
    const digest = "d".repeat(ACCUMULATED_CHANGE_DIGEST_MAX_CHARS);
    expect(
      chatAccumulatedFileChangeSummarySchema.safeParse({
        ...baseSummary(),
        digest,
      }).success,
    ).toBe(true);
  });

  it("rejects a digest longer than ACCUMULATED_CHANGE_DIGEST_MAX_CHARS", () => {
    const digest = "d".repeat(ACCUMULATED_CHANGE_DIGEST_MAX_CHARS + 1);
    expect(
      chatAccumulatedFileChangeSummarySchema.safeParse({
        ...baseSummary(),
        digest,
      }).success,
    ).toBe(false);
  });
});

describe("chatReadAccumulatedFileChangeResponseSchema's stale/fresh arms", () => {
  it("accepts the fresh (stale: false) arm with contents", () => {
    const parsed = chatReadAccumulatedFileChangeResponseSchema.parse({
      stale: false,
      beforeContent: "before",
      afterContent: "after",
    });
    expect(parsed).toEqual({
      stale: false,
      beforeContent: "before",
      afterContent: "after",
    });
  });

  it("accepts the stale (stale: true) arm", () => {
    const parsed = chatReadAccumulatedFileChangeResponseSchema.parse({
      stale: true,
    });
    expect(parsed).toEqual({ stale: true });
  });

  // Checked against the actual schema rather than assumed, per the ticket:
  // `stale: true` is a plain (non-strict) z.object with only `stale`
  // declared, so zod's default unknown-key behavior applies - extra keys are
  // SILENTLY STRIPPED, not rejected. Documented here as a guard against that
  // stripping ever regressing into "extra keys pass through untouched",
  // which would let a stale response carry contents by accident.
  it("strips (does not reject, and does not pass through) contents on a stale: true payload", () => {
    const parsed = chatReadAccumulatedFileChangeResponseSchema.parse({
      stale: true,
      beforeContent: "leaked-before",
      afterContent: "leaked-after",
    });
    expect(parsed).toEqual({ stale: true });
    expect(parsed).not.toHaveProperty("beforeContent");
    expect(parsed).not.toHaveProperty("afterContent");
  });
});

// ─── Group 5: chatIndexChangeSchema ─────────────────────────────────────────

describe("chatIndexChangeSchema", () => {
  function skeletonEntry() {
    return {
      rowId: "row-1",
      createdAt: 1000,
      role: "user" as const,
      byteLength: 10,
      // Required by the schema. These arms are about index-CHANGE routing, so
      // the digest's value is incidental - nothing here asserts on it.
      bodyDigest: "1x9k2mq0004zt7",
    };
  }

  it("parses the appended arm", () => {
    const parsed = chatIndexChangeSchema.parse({
      type: "appended",
      entries: [skeletonEntry()],
    });
    expect(parsed).toEqual({
      type: "appended",
      entries: [skeletonEntry()],
    });
  });

  it("parses the updated arm", () => {
    const parsed = chatIndexChangeSchema.parse({
      type: "updated",
      entries: [{ ordinal: 3, entry: skeletonEntry() }],
    });
    expect(parsed).toEqual({
      type: "updated",
      entries: [{ ordinal: 3, entry: skeletonEntry() }],
    });
  });

  it("parses the reindexed arm", () => {
    const parsed = chatIndexChangeSchema.parse({ type: "reindexed" });
    expect(parsed).toEqual({ type: "reindexed" });
  });

  it("rejects an unknown type", () => {
    expect(
      chatIndexChangeSchema.safeParse({ type: "removed", entries: [] }).success,
    ).toBe(false);
  });

  it("rejects an entry missing a required skeleton field", () => {
    // Through `chatIndexChangeSchema`, not `rowSkeletonEntrySchema` directly:
    // this suite is about the DELTA, and the question is whether its `appended`
    // arm still composes the entry schema. Parsing the entry on its own leaves
    // that composition untested and would keep passing if the arm stopped.
    const withoutRowId = { createdAt: 1000, role: "user", byteLength: 10 };
    expect(
      chatIndexChangeSchema.safeParse({
        type: "appended",
        entries: [withoutRowId],
      }).success,
    ).toBe(false);
  });
});

// ─── Group 6: chatLocateRowResponseSchema ───────────────────────────────────

/**
 * An ordinal is a coordinate, and a coordinate means nothing without the space
 * it is in. `chat.locateRow` is a unary RPC on a different connection from the
 * stream, so a restore or a compaction between the host numbering the row and
 * the client consuming the number leaves the client holding a position in a
 * space it has left - in range, fetchable, and pointing at the wrong row.
 *
 * The epoch is REQUIRED rather than optional for that reason: a producer that
 * omits it hands back an uncheckable coordinate, and the failure it causes is
 * silent at every layer below this schema.
 */
describe("chatLocateRowResponseSchema's found/not-found arms", () => {
  it("accepts a found answer stamped with the epoch it is numbered in", () => {
    const parsed = chatLocateRowResponseSchema.parse({
      found: true,
      ordinal: 42,
      epoch: 7,
    });
    expect(parsed).toEqual({ found: true, ordinal: 42, epoch: 7 });
  });

  it("rejects a found answer with no epoch", () => {
    expect(
      chatLocateRowResponseSchema.safeParse({ found: true, ordinal: 42 })
        .success,
    ).toBe(false);
  });

  it("accepts the opaque refusal, which carries nothing", () => {
    // `found: false` answers "no live session", "no row matches" and "you may
    // not read this chat" alike; anything that distinguished them would rebuild
    // the liveness oracle the sibling read closed.
    const parsed = chatLocateRowResponseSchema.parse({ found: false });
    expect(parsed).toEqual({ found: false });
  });

  it("strips an ordinal smuggled onto the refusal arm", () => {
    const parsed = chatLocateRowResponseSchema.parse({
      found: false,
      ordinal: 42,
      epoch: 7,
    });
    expect(parsed).toEqual({ found: false });
    expect(parsed).not.toHaveProperty("ordinal");
  });
});
