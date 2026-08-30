import { describe, expect, it } from "vitest";
import {
  assistantRowId,
  assistantSliceRowId,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  HydratedSpan,
  TranscriptWindow,
} from "@/stores/chats/transcript-window";
import {
  transcriptListRows,
  unplacedRowKey,
  visibleOrdinalRange,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";

/**
 * The merge that makes the transcript list `rowCount` long on the windowed
 * line. What these pin, in order of how badly each would fail in the wild:
 * placement reads the SPANS (so a sparse skeleton cannot duplicate a row), a
 * hydration transition changes the row's `kind` (so no comparator can freeze
 * stale content past it), and rows without an ordinal land after every ordinal.
 */

/*
 * Built FULL rather than cast into shape. A narrowing `as ChatMessage` does
 * not type-check here and the repo bans the `as unknown` escape - and the
 * fork-boundary suite already recorded why that is a good thing: a fixture
 * that asserts its own incomplete shape agrees with nothing real.
 */
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

function span(fromOrdinal: number, rowIds: readonly string[]): HydratedSpan {
  return {
    fromOrdinal,
    rowIds,
    messages: [],
    events: [],
    rowContext: {},
    bytes: rowIds.length * 32,
    contextBytes: 0,
    touchedAt: 1,
    servedAt: 1,
  };
}

function windowOf(input: {
  rowCount: number;
  spans: readonly HydratedSpan[];
  skeleton: readonly (RowSkeletonEntry | undefined)[];
  skeletonComplete: boolean;
  invalidated: boolean;
  liveMessages?: readonly Message[];
  liveEvents?: readonly ChatEvent[];
}): TranscriptWindow {
  return {
    epoch: 1,
    rowCount: input.rowCount,
    indexRevision: 1,
    indexRevisionRebuilding: false,
    skeleton: input.skeleton,
    skeletonComplete: input.skeletonComplete,
    skeletonStreamCoveredThrough: input.skeletonComplete ? input.rowCount : 0,
    spans: input.spans,
    liveMessages: [...(input.liveMessages ?? [])],
    liveEvents: [...(input.liveEvents ?? [])],
    snapshotProvisionalMessageIds: [],
    snapshotProvisionalEventIds: [],
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
    hydratedBytes: input.spans.reduce((sum, held) => sum + held.bytes, 0),
    unsettledByteMessageIds: [],
    invalidated: input.invalidated,
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
    // Codex P1 (#1459): hydrating ONE row of a steer-split assistant turn
    // pulls the turn's shared records, and rendering those projects EVERY row
    // of the turn. Only `r-2` was served, so `r-3` must stay a placeholder at
    // its own ordinal - appending it as an unplaced row draws it twice, once
    // out of order at the end and once as the placeholder still standing.
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
    // The duplication trap: reading `skeleton[ordinal].rowId` to place rows
    // would fail here, drop `r-1` through to the tail, and render it twice -
    // once as content at the bottom and once as a placeholder at ordinal 1.
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
