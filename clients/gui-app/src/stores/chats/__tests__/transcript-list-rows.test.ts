import { describe, expect, it, vi } from "vitest";
import {
  assistantRowId,
  assistantSliceRowId,
  projectTranscriptRows,
  queueSteerRowId,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  applyIndexChange,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  transcriptListRows,
  unplacedRowKey,
  visibleOrdinalRange,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";

/**
 * A counting PASSTHROUGH, not a stub: every test in this file still runs the real projection, so
 * nothing here relocates the invariant into a fake.
 */
vi.mock(
  "@traycer/protocol/persistence/chat-transcript/row-projection",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer/protocol/persistence/chat-transcript/row-projection")
      >();
    return {
      ...actual,
      projectTranscriptRows: vi.fn(actual.projectTranscriptRows),
    };
  },
);

/** The merge that makes the transcript list `rowCount` long on the windowed line. */

/** Built FULL rather than cast into shape. */
function model(id: string): ChatMessageModel {
  return {
    id,
    role: "assistant",
    content: `body of ${id}`,
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1000,
    completedAt: null,
    stopped: null,
    persistentMessageId: id,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function modelWithPersistentMessageId(
  id: string,
  persistentMessageId: string,
): ChatMessageModel {
  return { ...model(id), persistentMessageId };
}

function modelWithoutPersistentMessageId(id: string): ChatMessageModel {
  return { ...model(id), persistentMessageId: null };
}

function pendingModel(id: string): ChatMessageModel {
  return {
    ...modelWithoutPersistentMessageId(id),
    role: "user",
    statusLabel: "Pending",
  };
}

function skeletonEntry(rowId: string): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000,
    role: "assistant",
    byteLength: 32,
    bodyDigest: `d-${rowId}`,
  };
}

/** An assistant carrying a steer block whose steered USER record is absent. */
function steeredAssistant(
  turnId: string,
  queueItemId: string,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: `assistant-${turnId}`,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "steer" as const,
        blockId: `steer-${queueItemId}`,
        status: "completed" as const,
        timestamp: 1,
        queueItemId,
        messageId: "absent-steered-user",
        content: { type: "doc" as const },
        mode: "safe_point" as const,
        sender: null,
      },
    ],
    startedAt: 1,
    timestamp: 2,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function liveSplitAssistant(
  turnId: string,
  queueItemId: string,
): Extract<Message, { role: "assistant" }> {
  return {
    ...steeredAssistant(turnId, queueItemId),
    messageId: transientLiveAssistantMessageId(turnId),
    blocks: [
      {
        type: "text",
        blockId: `before-${turnId}`,
        status: "completed",
        timestamp: 1,
        text: "before",
        providerNotice: null,
      },
      {
        type: "steer",
        blockId: `steer-${queueItemId}`,
        status: "completed",
        timestamp: 2,
        queueItemId,
        messageId: `absent-${turnId}`,
        content: { type: "doc" },
        mode: "safe_point",
        sender: null,
      },
      {
        type: "text",
        blockId: `after-${turnId}`,
        status: "completed",
        timestamp: 3,
        text: "after",
        providerNotice: null,
      },
    ],
  };
}

/**
 * `class E` moved records and clocks off the span onto the window's ledger, so `windowOf` is what
 * actually seats a fixture's `messages`/`events` into `records` and turns this into a real
 */
interface SpanFixture {
  readonly fromOrdinal: number;
  readonly rowIds: readonly string[];
  readonly messages?: readonly Message[];
  readonly events?: readonly ChatEvent[];
  readonly servedAt?: number;
  readonly touchedAt?: number;
}

function span(fromOrdinal: number, rowIds: readonly string[]): SpanFixture {
  return { fromOrdinal, rowIds };
}

function windowOf(input: {
  rowCount: number;
  spans: readonly SpanFixture[];
  skeleton: readonly (RowSkeletonEntry | undefined)[];
  skeletonComplete: boolean;
  invalidated: boolean;
  liveMessages?: readonly Message[];
  liveEvents?: readonly ChatEvent[];
  staleSpans?: readonly SpanFixture[];
}): TranscriptWindow {
  const messageLedger = new Map<
    string,
    { record: Message; bytes: number; servedAt: number; touchedAt: number }
  >();
  const eventLedger = new Map<
    string,
    { record: ChatEvent; bytes: number; servedAt: number; touchedAt: number }
  >();

  const seat = (fixture: SpanFixture) => {
    const servedAt = fixture.servedAt ?? 1;
    const touchedAt = fixture.touchedAt ?? 1;
    for (const message of fixture.messages ?? []) {
      messageLedger.set(message.messageId, {
        record: message,
        bytes: recordByteLength(message),
        servedAt,
        touchedAt,
      });
    }
    for (const event of fixture.events ?? []) {
      eventLedger.set(event.eventId, {
        record: event,
        bytes: recordByteLength(event),
        servedAt,
        touchedAt,
      });
    }
    return {
      fromOrdinal: fixture.fromOrdinal,
      rowIds: fixture.rowIds,
      messageIds: (fixture.messages ?? []).map((message) => message.messageId),
      eventIds: (fixture.events ?? []).map((event) => event.eventId),
      rowContext: {},
      contextBytes: 0,
    };
  };

  const spans = input.spans.map(seat);
  const staleSpans = (input.staleSpans ?? []).map(seat);

  const freshMessageIds = new Set(spans.flatMap((held) => held.messageIds));
  const freshEventIds = new Set(spans.flatMap((held) => held.eventIds));
  let hydratedBytes = 0;
  for (const id of freshMessageIds) {
    hydratedBytes += messageLedger.get(id)?.bytes ?? 0;
  }
  for (const id of freshEventIds) {
    hydratedBytes += eventLedger.get(id)?.bytes ?? 0;
  }

  return {
    epoch: 1,
    rowCount: input.rowCount,
    indexRevision: 1,
    indexRevisionRebuilding: false,
    skeleton: input.skeleton,
    skeletonComplete: input.skeletonComplete,
    skeletonStreamCoveredThrough: input.skeletonComplete ? input.rowCount : 0,
    records: { messages: messageLedger, events: eventLedger, revision: 0 },
    spans,
    staleSpans,
    liveMessages: [...(input.liveMessages ?? [])],
    liveEvents: [...(input.liveEvents ?? [])],
    snapshotProvisionalMessageIds: [],
    snapshotProvisionalEventIds: [],
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
    hydratedBytes,
    evictionTerminal: "none",
    unsettledByteMessageIds: [],
    invalidated: input.invalidated,
    visibleOrdinals: null,
    clock: 1,
  };
}

function kinds(rows: readonly TranscriptListRow[]): string[] {
  return rows.map((row) =>
    row.kind === "hydrated" ? `H:${row.key}` : `P:${row.ordinal}`,
  );
}

describe("transcriptListRows", () => {
  it("keeps a live stopped-turn row visible while the index is invalidated", () => {
    const turnId = "turn-stopped";
    const stopped: ChatEvent = {
      eventId: "stopped-1",
      type: "turn.stopped",
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId,
      messageId: "triggering-user",
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { reason: "user_requested", turnHadOutput: false },
    };
    const stoppedRow = {
      ...modelWithoutPersistentMessageId(assistantRowId(turnId)),
      statusLabel: "Completed" as const,
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
        liveEvents: [stopped],
      }),
      rendered: [stoppedRow],
    });

    expect(kinds(rows)).toEqual(["P:0", `H:${assistantRowId(turnId)}`]);
  });

  it("keeps a setup card projected from live events while invalidated", () => {
    const setup: ChatEvent = {
      eventId: "setup-live",
      type: "setup.running",
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    };
    const setupRowId = "setup-card:chat-1:3:2";
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
        liveEvents: [setup],
      }),
      rendered: [
        modelWithoutPersistentMessageId("setup-card:chat-1:1:2"),
        modelWithoutPersistentMessageId(setupRowId),
      ],
    });

    expect(kinds(rows)).toEqual(["P:0", `H:${setupRowId}`]);
  });

  it("keeps every same-timestamp setup card projected from live events", () => {
    const setupEvent = (
      eventId: string,
      type: ChatEvent["type"] = "setup.running",
    ): ChatEvent => ({
      eventId,
      type,
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    });
    const firstRowId = "setup-card:chat-1:2:2";
    const secondRowId = "setup-card:chat-1:3:2";
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
        liveEvents: [
          setupEvent("setup-live-1"),
          // This boundary splits the same-timestamp setup events into two
          // projected setup-card windows, which is the cardinality under test.
          setupEvent("setup-boundary", "worktree.missing"),
          setupEvent("setup-live-2"),
        ],
      }),
      rendered: [
        modelWithoutPersistentMessageId("setup-card:chat-1:1:2"),
        modelWithoutPersistentMessageId(firstRowId),
        modelWithoutPersistentMessageId(secondRowId),
      ],
    });

    expect(kinds(rows)).toEqual(["P:0", `H:${firstRowId}`, `H:${secondRowId}`]);
  });

  it("leaves a partially-hydrated turn's unserved rows as placeholders", () => {
    // Codex P1 (#1459): hydrating ONE row of a steer-split assistant turn pulls the turn's shared
    // records, and rendering those projects EVERY row of the turn.
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 4,
        spans: [span(2, ["r-2"])],
        skeleton: [
          skeletonEntry("r-0"),
          skeletonEntry("r-1"),
          skeletonEntry("r-2"),
          skeletonEntry("r-3"),
        ],
        skeletonComplete: true,
        invalidated: false,
      }),
      // The renderer produced both halves of the turn from the shared records.
      rendered: [model("r-2"), model("r-3")],
    });

    expect(kinds(rows)).toEqual(["P:0", "P:1", "H:r-2", "P:3"]);
  });

  it("still appends a record the index genuinely does not name", () => {
    // The other side of the same guard: a live/pending record has no skeleton
    // entry, and must keep landing after every ordinal.
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [span(0, ["r-0", "r-1"])],
        skeleton: [skeletonEntry("r-0"), skeletonEntry("r-1")],
        skeletonComplete: true,
        invalidated: false,
      }),
      rendered: [model("r-0"), model("r-1"), model("live-turn")],
    });

    expect(kinds(rows)).toEqual(["H:r-0", "H:r-1", "H:live-turn"]);
  });

  it("keeps a transient assistant seated when the skeleton names its projected row", () => {
    const turnId = "turn-1";
    const transientId = transientLiveAssistantMessageId(turnId);
    const transient: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [],
      startedAt: 1,
      timestamp: 2,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const projectedRowId = assistantRowId(turnId);
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [skeletonEntry(projectedRowId)],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [transient],
      }),
      rendered: [modelWithPersistentMessageId(projectedRowId, transientId)],
    });

    expect(kinds(rows)).toEqual([`H:${projectedRowId}`]);
    expect(rows[0].ordinal).toBe(0);
  });

  it("seats every projected slice backed by one transient assistant record", () => {
    const turnId = "turn-split";
    const transientId = transientLiveAssistantMessageId(turnId);
    const firstRowId = assistantSliceRowId(turnId, 0, true);
    const secondRowId = assistantSliceRowId(turnId, 1, true);
    const transient: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [],
      startedAt: 1,
      timestamp: 2,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [],
        skeleton: [skeletonEntry(firstRowId), skeletonEntry(secondRowId)],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [transient],
      }),
      rendered: [
        modelWithPersistentMessageId(firstRowId, transientId),
        modelWithPersistentMessageId(secondRowId, transientId),
      ],
    });

    expect(kinds(rows)).toEqual([`H:${firstRowId}`, `H:${secondRowId}`]);
  });

  it("is the identity mapping on the legacy line", () => {
    const rendered = [model("a"), model("b")];

    const rows = transcriptListRows({ window: null, rendered });

    expect(kinds(rows)).toEqual(["H:a", "H:b"]);
    expect(rows.every((row) => row.ordinal === null)).toBe(true);
  });

  it("fills unhydrated ordinals with placeholders so the list is rowCount long", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 5,
        spans: [span(3, ["r-3", "r-4"])],
        skeleton: [
          skeletonEntry("r-0"),
          skeletonEntry("r-1"),
          skeletonEntry("r-2"),
          skeletonEntry("r-3"),
          skeletonEntry("r-4"),
        ],
        skeletonComplete: true,
        invalidated: false,
      }),
      rendered: [model("r-3"), model("r-4")],
    });

    expect(rows).toHaveLength(5);
    expect(kinds(rows)).toEqual(["P:0", "P:1", "P:2", "H:r-3", "H:r-4"]);
  });

  it("places a hydrated row from its SPAN even when its skeleton slot is a hole", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 3,
        spans: [span(1, ["r-1"])],
        skeleton: [skeletonEntry("r-0"), undefined, undefined],
        skeletonComplete: false,
        invalidated: false,
      }),
      rendered: [model("r-1")],
    });

    expect(kinds(rows)).toEqual(["P:0", "H:r-1", "P:2"]);
    expect(rows.filter((row) => row.key === "r-1")).toHaveLength(1);
  });

  it("keys a placeholder on its skeleton rowId, or on the ordinal while it is a hole", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [],
        skeleton: [skeletonEntry("r-0"), undefined],
        skeletonComplete: false,
        invalidated: false,
      }),
      rendered: [],
    });

    expect(rows[0].key).toBe("r-0");
    expect(rows[1].key).toBe(unplacedRowKey(1));
    expect(rows[0].kind === "placeholder" && rows[0].entry !== null).toBe(true);
    expect(rows[1].kind === "placeholder" && rows[1].entry === null).toBe(true);
  });

  it("changes a row's kind when it hydrates, which no comparator can look past", () => {
    const skeleton = [skeletonEntry("r-0")];
    const before = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton,
        skeletonComplete: true,
        invalidated: false,
      }),
      rendered: [],
    });
    const after = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [span(0, ["r-0"])],
        skeleton,
        skeletonComplete: true,
        invalidated: false,
      }),
      rendered: [model("r-0")],
    });

    expect(before[0].kind).toBe("placeholder");
    expect(after[0].kind).toBe("hydrated");
    // Same key across the transition, so the list keeps the row's identity and
    // its scroll position rather than remounting it as a new row.
    expect(after[0].key).toBe(before[0].key);
  });

  it("puts rows that own no ordinal after every ordinal", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [span(0, ["r-0"])],
        skeleton: [skeletonEntry("r-0"), skeletonEntry("r-1")],
        skeletonComplete: true,
        invalidated: false,
      }),
      // `pending-1` is a live/pending row: no span places it.
      rendered: [model("r-0"), model("pending-1")],
    });

    expect(kinds(rows)).toEqual(["H:r-0", "P:1", "H:pending-1"]);
    expect(rows[2].ordinal).toBe(null);
  });

  it("keeps the ordinal space mounted when the index is void", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 9,
        spans: [span(0, ["r-0"])],
        skeleton: [skeletonEntry("r-0")],
        skeletonComplete: false,
        invalidated: true,
      }),
      rendered: [model("r-0")],
    });

    expect(kinds(rows)).toEqual([
      "P:0",
      "P:1",
      "P:2",
      "P:3",
      "P:4",
      "P:5",
      "P:6",
      "P:7",
      "P:8",
    ]);
    expect(rows.slice(0, 9).every((row) => row.kind === "placeholder")).toBe(
      true,
    );
  });

  it("does not expose a known nonempty void as an empty chat", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 5_000,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
      }),
      rendered: [],
    });

    expect(rows).toHaveLength(5_000);
    expect(rows[0]).toMatchObject({ kind: "placeholder", ordinal: 0 });
    expect(rows.at(-1)).toMatchObject({
      kind: "placeholder",
      ordinal: 4_999,
    });
  });

  it("does not append a span-backed synthetic row after void placeholders", () => {
    const syntheticId = "forked-chat-link:event-1";
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [span(0, [syntheticId])],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
      }),
      rendered: [modelWithoutPersistentMessageId(syntheticId)],
    });

    expect(kinds(rows)).toEqual(["P:0"]);
  });

  it("keeps a skeleton-named live row after void placeholders", () => {
    const liveId = "accepted-user-in-skeleton";
    const liveMessage: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: liveId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [],
      startedAt: 1,
      timestamp: 2,
      turnId: "turn-in-skeleton",
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [skeletonEntry(liveId)],
        skeletonComplete: true,
        invalidated: true,
        liveMessages: [liveMessage],
      }),
      rendered: [modelWithPersistentMessageId(liveId, liveId)],
    });

    expect(kinds(rows)).toEqual(["P:0", `H:${liveId}`]);
  });

  it("keeps a genuinely pending null-record row after void placeholders", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
      }),
      rendered: [pendingModel("pending-user")],
    });

    expect(kinds(rows)).toEqual(["P:0", "H:pending-user"]);
  });

  it("a send-induced reindex keeps every drawn row on screen through the void", () => {
    const before = windowOf({
      rowCount: 3,
      spans: [span(0, ["u-1", "a-1", "u-2"])],
      skeleton: [
        skeletonEntry("u-1"),
        skeletonEntry("a-1"),
        skeletonEntry("u-2"),
      ],
      skeletonComplete: true,
      invalidated: false,
    });
    const rendered = [model("u-1"), model("a-1"), model("u-2")];
    const drawn = kinds(transcriptListRows({ window: before, rendered }));
    expect(drawn).toEqual(["H:u-1", "H:a-1", "H:u-2"]);

    const voided = applyIndexChange(before, {
      activeTurnId: null,
      epoch: 2,
      rowCount: 3,
      indexRevision: 1,
      changes: [{ type: "reindexed" }],
    });
    expect(voided.invalidated).toBe(true);

    // Same rows under the same keys: the void is invisible, and the list
    // never remounts a row it had already measured.
    expect(kinds(transcriptListRows({ window: voided, rendered }))).toEqual(
      drawn,
    );
  });

  it("keeps an orphaned steer projected from the live assistant during invalidation", () => {
    const turnId = "turn-live-steer";
    const transientId = transientLiveAssistantMessageId(turnId);
    const transient: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          blockId: "steer-live",
          status: "completed",
          timestamp: 1,
          type: "steer",
          queueItemId: "queue-live",
          messageId: "missing-steered-user",
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
      ],
      startedAt: 1,
      timestamp: 2,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
        liveMessages: [transient],
      }),
      rendered: [modelWithoutPersistentMessageId("steer:queue-live")],
    });

    expect(kinds(rows)).toEqual(["P:0", "H:steer:queue-live"]);
  });

  it("projects a live steer with its retained span-backed user dependency", () => {
    const turnId = "turn-live-steer-with-user";
    const steeredMessageId = "steered-user";
    const transient: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientLiveAssistantMessageId(turnId),
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          blockId: "steer-with-user",
          status: "completed",
          timestamp: 1,
          type: "steer",
          queueItemId: "queue-with-user",
          messageId: steeredMessageId,
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
      ],
      startedAt: 1,
      timestamp: 2,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const steeredUser: Extract<Message, { role: "user" }> = {
      role: "user",
      messageId: steeredMessageId,
      sender: { type: "user", userId: "owner-1" },
      message: {
        kind: "user",
        content: { type: "doc" },
        browserAnnotations: [],
      },
      timestamp: 1,
      sessionAnchor: null,
    };
    const retainedSpan = {
      ...span(0, [assistantRowId("retained-sibling")]),
      messages: [steeredUser],
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [retainedSpan],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
        liveMessages: [transient],
      }),
      rendered: [modelWithoutPersistentMessageId(steeredMessageId)],
    });

    expect(kinds(rows)).toEqual(["P:0", `H:${steeredMessageId}`]);
  });

  it("withholds a sibling slice of a stale-held record from the live tail", () => {
    // A stale span lists only the row ids its partial range SERVED, while one assistant record
    // projects into every slice of its turn.
    const staleAssistant: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: "stale-assistant",
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [],
      startedAt: 1,
      timestamp: 2,
      turnId: "turn-carried",
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [
          {
            ...span(0, [assistantRowId("turn-carried")]),
            messages: [staleAssistant],
          },
        ],
      }),
      // A slice projected from that record: its own row id was never served,
      // so only the record it names identifies it as history.
      rendered: [
        modelWithPersistentMessageId("carried-slice", "stale-assistant"),
      ],
    });

    expect(kinds(rows)).toEqual(["P:0"]);
  });

  it("does not retain an unrelated historical orphan steer during invalidation", () => {
    const turnId = "turn-unrelated-live";
    const transient: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientLiveAssistantMessageId(turnId),
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [],
      startedAt: 1,
      timestamp: 2,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [span(0, [""])],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
        liveMessages: [transient],
      }),
      rendered: [modelWithoutPersistentMessageId("steer:historical")],
    });

    expect(kinds(rows)).toEqual(["P:0"]);
  });

  it("does not append a synthetic row from an unresolved tail span", () => {
    const syntheticId = "forked-chat-link:event-unresolved";
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [span(0, [""])],
        skeleton: [],
        skeletonComplete: false,
        invalidated: true,
      }),
      rendered: [modelWithoutPersistentMessageId(syntheticId)],
    });

    expect(kinds(rows)).toEqual(["P:0"]);
  });

  it("reuses invalidated placeholder objects across streaming renders", () => {
    const window = windowOf({
      rowCount: 2,
      spans: [],
      skeleton: [],
      skeletonComplete: false,
      invalidated: true,
    });
    const first = transcriptListRows({ window, rendered: [] });
    const streamed = transcriptListRows({
      window,
      rendered: [pendingModel("pending-user")],
    });

    expect(streamed[0]).toBe(first[0]);
    expect(streamed[1]).toBe(first[1]);
  });

  it("drops a span row that claims an ordinal past rowCount", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [span(1, ["r-1", "r-2-past-end"])],
        skeleton: [skeletonEntry("r-0"), skeletonEntry("r-1")],
        skeletonComplete: true,
        invalidated: false,
      }),
      rendered: [model("r-1"), model("r-2-past-end")],
    });

    expect(rows).toHaveLength(3);
    // The list stays `rowCount` long; the unplaceable row falls to the tail
    // rather than rendering beyond the end of the transcript.
    expect(kinds(rows)).toEqual(["P:0", "H:r-1", "H:r-2-past-end"]);
  });

  it("keeps a streaming row at the tail when a stale span also backs it", () => {
    // The row cannot take its old ordinal - the replacement skeleton has already filled that slot
    // without naming it - so it reaches the tail gate as unplaced.
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [],
        skeleton: [skeletonEntry("r-0"), skeletonEntry("r-1")],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [span(0, ["streaming-row"])],
      }),
      rendered: [{ ...model("streaming-row"), statusLabel: "Streaming" }],
    });

    expect(kinds(rows)).toEqual(["P:0", "P:1", "H:streaming-row"]);
  });

  it("still withholds a stale-only row that nothing live backs", () => {
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [],
        skeleton: [skeletonEntry("r-0"), skeletonEntry("r-1")],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [span(0, ["history-row"])],
      }),
      rendered: [model("history-row")],
    });

    expect(kinds(rows)).toEqual(["P:0", "P:1"]);
  });

  it("suppresses the ordinal of a carried row the index names and the renderer withheld", () => {
    // The same inference the fresh-span pass makes from the same evidence: the tier proves the body is
    // HELD, so a missing model is renderer POLICY (an assistant row whose only segments were lifted
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [],
        skeleton: [skeletonEntry("withheld-row"), skeletonEntry("carried-row")],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [span(0, ["withheld-row", "carried-row"])],
      }),
      rendered: [model("carried-row")],
    });

    expect(kinds(rows)).toEqual(["H:carried-row"]);
  });

  // Class E moved those clocks onto the per-record LEDGER (`spanServeStamp`/derived from
  // `window.records`), so a span with no `messages`/`events` now derives a serve stamp of 0
  it("resolves a duplicated stale row via the tie-break's earliest-span order", () => {
    const older: SpanFixture = {
      ...span(0, ["only-in-old", "dup"]),
      servedAt: 5,
    };
    const newer: SpanFixture = { ...span(4, ["dup"]), servedAt: 9 };
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 6,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [older, newer],
      }),
      rendered: [model("only-in-old"), model("dup")],
    });

    expect(kinds(rows)).toEqual([
      "H:only-in-old",
      "H:dup",
      "P:2",
      "P:3",
      "P:4",
      "P:5",
    ]);
  });

  it("withholds a steer row inferred from a turn only the stale tier holds", () => {
    // An INFERRED row was never served, so no id-set fold can contain it: the steer entry
    // `planAssistantTurnRows` emits for a turn holding a steer block takes a synthesized
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [
          {
            ...span(0, [assistantRowId("turn-steered")]),
            messages: [steeredAssistant("turn-steered", "q-1")],
          },
        ],
      }),
      rendered: [
        modelWithoutPersistentMessageId(queueSteerRowId("q-1")),
        model(assistantRowId("turn-steered")),
      ],
    });

    expect(kinds(rows)).toEqual(["H:" + assistantRowId("turn-steered")]);
  });

  it("projects the whole history ONCE when both tiers ask a steer question", () => {
    // `appendUnplacedRenderedRows` reaches both lookups for a single model: a synthesized steer row
    // answers the stale question through the projection, and is then asked the live one.
    const liveTransient = {
      ...steeredAssistant("turn-live", "q-2"),
      messageId: transientLiveAssistantMessageId("turn-live"),
    };
    vi.mocked(projectTranscriptRows).mockClear();

    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: false,
        liveMessages: [liveTransient],
        staleSpans: [
          {
            ...span(0, [assistantRowId("turn-stale")]),
            messages: [steeredAssistant("turn-stale", "q-1")],
          },
        ],
      }),
      rendered: [
        modelWithoutPersistentMessageId(queueSteerRowId("q-1")),
        model(assistantRowId("turn-stale")),
      ],
    });

    // The answer both folds produced, unchanged: the stale-only steer row is
    // withheld from the tail.
    expect(kinds(rows)).toEqual(["H:" + assistantRowId("turn-stale")]);
    expect(vi.mocked(projectTranscriptRows)).toHaveBeenCalledTimes(1);
  });

  it("keeps a steer row whose turn the LIVE tier also holds", () => {
    // The other direction, and the one this pass has twice been bitten by: a turn the live tier also
    // holds is not pre-rebase history, and the turn streaming right now is the turn a rebase most
    const streaming = steeredAssistant("turn-steered", "q-1");
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [],
        skeletonComplete: false,
        invalidated: false,
        liveMessages: [streaming],
        staleSpans: [
          {
            ...span(0, [assistantRowId("turn-steered")]),
            messages: [streaming],
          },
        ],
      }),
      rendered: [
        modelWithoutPersistentMessageId(queueSteerRowId("q-1")),
        model(assistantRowId("turn-steered")),
      ],
    });

    expect(kinds(rows)).toEqual([
      "H:" + assistantRowId("turn-steered"),
      "H:" + queueSteerRowId("q-1"),
    ]);
  });

  /**
   * A same-turn steer split into TWO host frames, reproduced independently of the host's publish
   * order.
   */
  it("does not seat a mixed-state steer row above its own unplaced turn", () => {
    const turnId = "turn-mixed-steer";
    const queueItemId = "queue-mixed";
    const steeredMessageId = "steered-user-mixed";
    const transientId = transientLiveAssistantMessageId(turnId);

    const steeredUser: Extract<Message, { role: "user" }> = {
      role: "user",
      messageId: steeredMessageId,
      sender: { type: "user", userId: "owner-1" },
      message: {
        kind: "user",
        content: { type: "doc" },
        browserAnnotations: [],
      },
      timestamp: 2,
      sessionAnchor: null,
    };
    // The POST-blockDelta live assistant record: the steer block now sits between two completed text
    // blocks, which is what makes the turn SPLIT (`planAssistantTurnRows`) into `:part:0` / steer /
    const transientAssistant: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          type: "text",
          blockId: "block-before",
          status: "completed",
          timestamp: 1,
          text: "before the steer",
          providerNotice: null,
        },
        {
          type: "steer",
          blockId: `steer-${queueItemId}`,
          status: "completed",
          timestamp: 2,
          queueItemId,
          messageId: steeredMessageId,
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
        {
          type: "text",
          blockId: "block-after",
          status: "completed",
          timestamp: 3,
          text: "after the steer",
          providerNotice: null,
        },
      ],
      startedAt: 1,
      timestamp: 3,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };

    const part0Id = assistantSliceRowId(turnId, 0, true);
    const part1Id = assistantSliceRowId(turnId, 1, true);
    const rows = transcriptListRows({
      window: windowOf({
        spans: [],
        rowCount: 4,
        // STALE / marker-less: the last skeleton the host published before the steer block existed.
        skeleton: [
          skeletonEntry("prior-user"),
          skeletonEntry(assistantRowId(turnId)),
          skeletonEntry(steeredMessageId),
          skeletonEntry("later-indexed-row"),
        ],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [steeredUser, transientAssistant],
      }),
      rendered: [
        modelWithPersistentMessageId(part0Id, transientId),
        modelWithoutPersistentMessageId(steeredMessageId),
        modelWithPersistentMessageId(part1Id, transientId),
      ],
    });

    // No duplicate: the steered user's messageId draws exactly one row,
    // whichever position it lands at.
    const steerOccurrences = rows.filter(
      (row) => row.kind === "hydrated" && row.model.id === steeredMessageId,
    ).length;
    expect(steerOccurrences).toBe(1);

    const part0Index = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === part0Id,
    );
    const part1Index = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === part1Id,
    );
    const steerIndex = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === steeredMessageId,
    );

    // The canonical placement (what the host's OWN projection puts here, and what a fresh reindex
    // eventually corrects to): nested inside the turn, after `:part:0` and before `:part:1` - never
    expect(steerIndex).toBeGreaterThan(part0Index);
    expect(steerIndex).toBeLessThan(part1Index);
    // A virtualized slice can contain only a LATER member of a tall recovered
    // unit. It must still protect the unit's indexed position.
    expect(visibleOrdinalRange(rows, steerIndex, part1Index + 1)).toEqual({
      fromOrdinal: 1,
      toOrdinal: 2,
    });
    const laterIndex = rows.findIndex(
      (row) =>
        row.kind === "placeholder" && row.entry?.rowId === "later-indexed-row",
    );
    expect(part1Index).toBeLessThan(laterIndex);
  });

  it("merges multiple recovered split turns around surviving indexed rows", () => {
    const firstTurnId = "turn-first-split";
    const secondTurnId = "turn-second-split";
    const firstQueueId = "queue-first-split";
    const secondQueueId = "queue-second-split";
    const firstTransientId = transientLiveAssistantMessageId(firstTurnId);
    const secondTransientId = transientLiveAssistantMessageId(secondTurnId);
    const firstPart0 = assistantSliceRowId(firstTurnId, 0, true);
    const firstPart1 = assistantSliceRowId(firstTurnId, 1, true);
    const secondPart0 = assistantSliceRowId(secondTurnId, 0, true);
    const secondPart1 = assistantSliceRowId(secondTurnId, 1, true);
    const firstSteer = queueSteerRowId(firstQueueId);
    const secondSteer = queueSteerRowId(secondQueueId);

    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 5,
        spans: [],
        skeleton: [
          skeletonEntry("before-both"),
          skeletonEntry(assistantRowId(firstTurnId)),
          skeletonEntry("between-turns"),
          skeletonEntry(assistantRowId(secondTurnId)),
          skeletonEntry("after-both"),
        ],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [
          liveSplitAssistant(firstTurnId, firstQueueId),
          liveSplitAssistant(secondTurnId, secondQueueId),
        ],
      }),
      rendered: [
        modelWithPersistentMessageId(firstPart0, firstTransientId),
        modelWithoutPersistentMessageId(firstSteer),
        modelWithPersistentMessageId(firstPart1, firstTransientId),
        modelWithPersistentMessageId(secondPart0, secondTransientId),
        modelWithoutPersistentMessageId(secondSteer),
        modelWithPersistentMessageId(secondPart1, secondTransientId),
      ],
    });

    expect(kinds(rows)).toEqual([
      "P:0",
      `H:${firstPart0}`,
      `H:${firstSteer}`,
      `H:${firstPart1}`,
      "P:2",
      `H:${secondPart0}`,
      `H:${secondSteer}`,
      `H:${secondPart1}`,
      "P:4",
    ]);
    expect(
      rows.filter((row) => row.kind === "hydrated").map((row) => row.ordinal),
    ).toEqual([1, 1, 1, 3, 3, 3]);
  });

  it("keeps a stale-carried split row inside its recovered unit", () => {
    const turnId = "turn-stale-carried-split";
    const queueItemId = "queue-stale-carried-split";
    const transientId = transientLiveAssistantMessageId(turnId);
    const assistant = liveSplitAssistant(turnId, queueItemId);
    const part0Id = assistantSliceRowId(turnId, 0, true);
    const part1Id = assistantSliceRowId(turnId, 1, true);
    const steerId = queueSteerRowId(queueItemId);

    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 3,
        spans: [],
        staleSpans: [
          {
            ...span(2, [part0Id]),
            messages: [assistant],
          },
        ],
        skeleton: [
          skeletonEntry("prior-user"),
          skeletonEntry(assistantRowId(turnId)),
          undefined,
        ],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [assistant],
      }),
      rendered: [
        modelWithPersistentMessageId(part0Id, transientId),
        modelWithoutPersistentMessageId(steerId),
        modelWithPersistentMessageId(part1Id, transientId),
      ],
    });

    expect(kinds(rows)).toEqual([
      "P:0",
      `H:${part0Id}`,
      `H:${steerId}`,
      `H:${part1Id}`,
    ]);
    expect(rows.filter((row) => row.key === part0Id)).toHaveLength(1);
  });

  it("holds a split-turn row a fresh span already seated at its pre-split ordinal", () => {
    // That span is not newer evidence than the live record - it was built from the same pre-split
    // index - so the hold must outrank it.
    const turnId = "turn-span-seated-steer";
    const queueItemId = "queue-span-seated";
    const steeredMessageId = "steered-user-span-seated";
    const transientId = transientLiveAssistantMessageId(turnId);

    const steeredUser: Extract<Message, { role: "user" }> = {
      role: "user",
      messageId: steeredMessageId,
      sender: { type: "user", userId: "owner-1" },
      message: {
        kind: "user",
        content: { type: "doc" },
        browserAnnotations: [],
      },
      timestamp: 2,
      sessionAnchor: null,
    };
    const transientAssistant: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          type: "text",
          blockId: "block-before",
          status: "completed",
          timestamp: 1,
          text: "before the steer",
          providerNotice: null,
        },
        {
          type: "steer",
          blockId: `steer-${queueItemId}`,
          status: "completed",
          timestamp: 2,
          queueItemId,
          messageId: steeredMessageId,
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
        {
          type: "text",
          blockId: "block-after",
          status: "completed",
          timestamp: 3,
          text: "after the steer",
          providerNotice: null,
        },
      ],
      startedAt: 1,
      timestamp: 3,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };

    const part0Id = assistantSliceRowId(turnId, 0, true);
    const part1Id = assistantSliceRowId(turnId, 1, true);
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 3,
        // The served range: the prior user row and, at ordinal 2, the steered
        // user's own row id under the pre-split topology.
        spans: [
          {
            ...span(0, ["prior-user"]),
            messages: [],
          },
          {
            ...span(2, [steeredMessageId]),
            messages: [steeredUser],
          },
        ],
        skeleton: [
          skeletonEntry("prior-user"),
          skeletonEntry(assistantRowId(turnId)),
          skeletonEntry(steeredMessageId),
        ],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [steeredUser, transientAssistant],
      }),
      rendered: [
        modelWithPersistentMessageId("prior-user", "prior-user"),
        modelWithPersistentMessageId(part0Id, transientId),
        modelWithoutPersistentMessageId(steeredMessageId),
        modelWithPersistentMessageId(part1Id, transientId),
      ],
    });

    const steerOccurrences = rows.filter(
      (row) => row.kind === "hydrated" && row.model.id === steeredMessageId,
    ).length;
    expect(steerOccurrences).toBe(1);

    const part0Index = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === part0Id,
    );
    const part1Index = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === part1Id,
    );
    const steerIndex = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === steeredMessageId,
    );
    expect(steerIndex).toBeGreaterThan(part0Index);
    expect(steerIndex).toBeLessThan(part1Index);
    // The vacated ordinal draws nothing rather than a placeholder: a row is
    // there, and it is being drawn in the recovered unit.
    expect(
      rows.some((row) => row.kind === "placeholder" && row.ordinal === 2),
    ).toBe(false);
  });

  it("lands a pending-blockDelta steer bubble below its turn, not above it", () => {
    const turnId = "turn-pre-steer";
    const steeredMessageId = "steered-user-pre";
    const transientId = transientLiveAssistantMessageId(turnId);

    const steeredUser: Extract<Message, { role: "user" }> = {
      role: "user",
      messageId: steeredMessageId,
      sender: { type: "user", userId: "owner-1" },
      message: {
        kind: "user",
        content: { type: "doc" },
        browserAnnotations: [],
      },
      timestamp: 2,
      sessionAnchor: null,
    };
    // PRE-blockDelta: no steer block yet, so the turn is still unsplit.
    const transientAssistant: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          type: "text",
          blockId: "block-streaming",
          status: "streaming",
          timestamp: 1,
          text: "still going",
          providerNotice: null,
        },
      ],
      startedAt: 1,
      timestamp: 1,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };

    const assistantId = assistantRowId(turnId);
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 3,
        spans: [],
        skeleton: [
          skeletonEntry("prior-user"),
          skeletonEntry(assistantId),
          skeletonEntry(steeredMessageId),
        ],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [steeredUser, transientAssistant],
      }),
      rendered: [
        modelWithPersistentMessageId(assistantId, transientId),
        modelWithPersistentMessageId(steeredMessageId, steeredMessageId),
      ],
    });

    const steerOccurrences = rows.filter(
      (row) => row.kind === "hydrated" && row.model.id === steeredMessageId,
    ).length;
    expect(steerOccurrences).toBe(1);

    const assistantIndex = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === assistantId,
    );
    const steerIndex = rows.findIndex(
      (row) => row.kind === "hydrated" && row.model.id === steeredMessageId,
    );

    // Below the streaming turn - the last ordinal, not adjacent to the prior
    // user row above the turn.
    expect(steerIndex).toBeGreaterThan(assistantIndex);
    expect(rows[steerIndex].ordinal).toBe(2);
  });
});

describe("tier-parameterized backing", () => {
  it("a Pending model the skeleton names with no live record behind it seats at its ordinal", () => {
    const pendingRowId = "pending-named-in-skeleton";
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [skeletonEntry(pendingRowId)],
        skeletonComplete: true,
        invalidated: false,
      }),
      rendered: [pendingModel(pendingRowId)],
    });

    expect(kinds(rows)).toEqual([`H:${pendingRowId}`]);
    expect(rows.filter((row) => row.key === pendingRowId)).toHaveLength(1);
  });

  it("a skeleton-named setup card projected from live events seats at its ordinal", () => {
    // Mirrors the module's own `projectedLiveSetupRowIds` fixture shape (see "keeps a setup card
    // projected from live events while invalidated" above): one live `setup.*` event projects exactly
    const setup: ChatEvent = {
      eventId: "setup-live-seated",
      type: "setup.running",
      timestamp: 2,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { workspacePath: "/workspace" },
    };
    const setupRowId = "setup-card:chat-1:0:2";
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [skeletonEntry(setupRowId)],
        skeletonComplete: true,
        invalidated: false,
        liveEvents: [setup],
      }),
      rendered: [modelWithoutPersistentMessageId(setupRowId)],
    });

    expect(kinds(rows)).toEqual([`H:${setupRowId}`]);
    expect(rows[0].ordinal).toBe(0);
  });

  it("a Pending status backs nothing in the stale tier", () => {
    // The status-label channel is declared live-only in BACKING_CHANNELS precisely so a model the
    // renderer calls Pending can never be read as STALE-backed off the label alone.
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 2,
        spans: [],
        skeleton: [skeletonEntry("r-0"), skeletonEntry("r-1")],
        skeletonComplete: false,
        invalidated: false,
        staleSpans: [span(0, ["history-row"])],
      }),
      rendered: [pendingModel("pending-user"), model("history-row")],
    });

    expect(kinds(rows)).toEqual(["P:0", "P:1", "H:pending-user"]);
  });

  it("a steer-split model with no persistent id resolves through the steer channel on both tiers", () => {
    // The append-tail half of steer eligibility (stale-only suppression vs.
    const turnId = "turn-live-steer-seated";
    const transient: Extract<Message, { role: "assistant" }> = {
      role: "assistant",
      messageId: transientLiveAssistantMessageId(turnId),
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [
        {
          blockId: "steer-seated",
          status: "completed",
          timestamp: 1,
          type: "steer",
          queueItemId: "queue-seated",
          messageId: "missing-steered-user-seated",
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
      ],
      startedAt: 1,
      timestamp: 2,
      turnId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
    const steerRowId = queueSteerRowId("queue-seated");
    const rows = transcriptListRows({
      window: windowOf({
        rowCount: 1,
        spans: [],
        skeleton: [skeletonEntry(steerRowId)],
        skeletonComplete: true,
        invalidated: false,
        liveMessages: [transient],
      }),
      rendered: [modelWithoutPersistentMessageId(steerRowId)],
    });

    expect(kinds(rows)).toEqual([`H:${steerRowId}`]);
    expect(rows[0].ordinal).toBe(0);
  });
});

describe("visibleOrdinalRange", () => {
  const rows = transcriptListRows({
    window: windowOf({
      rowCount: 4,
      spans: [span(1, ["r-1"])],
      skeleton: [
        skeletonEntry("r-0"),
        skeletonEntry("r-1"),
        skeletonEntry("r-2"),
        skeletonEntry("r-3"),
      ],
      skeletonComplete: true,
      invalidated: false,
    }),
    rendered: [model("r-1"), model("pending")],
  });

  it("spans the ordinals the visible slice covers, end-exclusive", () => {
    expect(visibleOrdinalRange(rows, 1, 3)).toEqual({
      fromOrdinal: 1,
      toOrdinal: 3,
    });
  });

  it("ignores rows with no ordinal", () => {
    // Index 4 is the pending tail row.
    expect(visibleOrdinalRange(rows, 3, 5)).toEqual({
      fromOrdinal: 3,
      toOrdinal: 4,
    });
  });

  it("is null when the slice holds no placed row", () => {
    expect(visibleOrdinalRange(rows, 4, 5)).toBe(null);
  });

  it("clamps a slice that runs past either end", () => {
    expect(visibleOrdinalRange(rows, -10, 99)).toEqual({
      fromOrdinal: 0,
      toOrdinal: 4,
    });
  });
});
