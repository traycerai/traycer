import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import {
  assistantRowId,
  assistantRowTurnKey,
  assistantSliceRowId,
  planAssistantTurnRows,
  projectTranscriptRows,
  assistantTurnNeedsTrailingRow,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * These pin the rules a cold review found the previous record-level enumeration
 * getting wrong. Each `describe` maps to one of them, because each one shifts
 * every later ordinal when it breaks - and a shifted ordinal renders a
 * neighbour's body under a row rather than failing.
 */

function textBlock(blockId: string, timestamp: number): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "text" as const,
    text: "hi",
    providerNotice: null,
  };
}

function steerBlock(
  blockId: string,
  timestamp: number,
  messageId: string,
): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "steer" as const,
    queueItemId: `q-${blockId}`,
    messageId,
    content: { type: "doc" },
    mode: "safe_point" as const,
    sender: null,
  };
}

function userMessage(fields: {
  messageId: string;
  timestamp: number;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "doc" } },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

function assistantMessage(fields: {
  messageId: string;
  timestamp: number;
  turnId: string | null;
  startedAt: number | null;
  blocks: readonly ContentBlock[];
}): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId: fields.messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: fields.blocks,
    startedAt: fields.startedAt,
    timestamp: fields.timestamp,
    turnId: fields.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}

function stoppedEvent(fields: {
  eventId: string;
  turnId: string;
  timestamp: number;
  messageId: string | null;
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: "turn.stopped",
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: "Stop requested by owner.",
    turnId: fields.turnId,
    messageId: fields.messageId,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  });
}

function setupEvent(fields: {
  eventId: string;
  type: "setup.creating" | "setup.running" | "setup.succeeded";
  timestamp: number;
  workspacePath: string;
  triggeringMessageId?: string;
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: fields.type,
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata:
      fields.triggeringMessageId === undefined
        ? { workspacePath: fields.workspacePath }
        : {
            workspacePath: fields.workspacePath,
            triggeringMessageId: fields.triggeringMessageId,
          },
  });
}

function pauseEvent(fields: {
  eventId: string;
  type: ChatEvent["type"];
  timestamp: number;
  turnId: string | null;
  approvalId: string | null;
  blockId: string | null;
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: fields.type,
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: fields.turnId,
    messageId: null,
    queueItemId: null,
    approvalId: fields.approvalId,
    blockId: fields.blockId,
    severity: "info",
    metadata: null,
  });
}

function decoratingIdsOf(
  messages: readonly Message[],
  events: readonly ChatEvent[],
): readonly string[] {
  const row = projectTranscriptRows({
    messages,
    events,
    activeTurnId: null,
    chatId: "chat-1",
  }).find((candidate) => candidate.source.kind === "assistant-slice");
  if (row === undefined || row.source.kind !== "assistant-slice") {
    throw new Error("no assistant row projected");
  }
  return row.source.decoratingEventIds;
}

function project(
  messages: readonly Message[],
  events: readonly ChatEvent[],
  activeTurnId: string | null,
): readonly string[] {
  return projectTranscriptRows({
    messages,
    events,
    activeTurnId,
    chatId: "chat-1",
  }).map((row) => row.rowId);
}

describe("turn folding", () => {
  it("folds several records sharing a turn id into ONE row", () => {
    // The defect that started this module: three records, one rendered row.
    // A one-per-record enumeration would reserve three ordinals here and put
    // every later body two rows out of place.
    const records = [1, 2, 3].map((n) =>
      assistantMessage({
        messageId: `m-${n}`,
        timestamp: n,
        turnId: "t-1",
        startedAt: 10,
        blocks: [textBlock(`b-${n}`, n)],
      }),
    );

    expect(project(records, [], null)).toEqual(["assistant:t-1"]);
  });

  it("keeps records with different turn ids as separate rows", () => {
    const first = assistantMessage({
      messageId: "m-1",
      timestamp: 1,
      turnId: "t-1",
      startedAt: 1,
      blocks: [textBlock("b-1", 1)],
    });
    const second = assistantMessage({
      messageId: "m-2",
      timestamp: 2,
      turnId: "t-2",
      startedAt: 2,
      blocks: [textBlock("b-2", 2)],
    });

    expect(project([first, second], [], null)).toEqual([
      "assistant:t-1",
      "assistant:t-2",
    ]);
  });

  it("groups legacy records with no turnId by their own timestamp", () => {
    const legacy = assistantMessage({
      messageId: "m-1",
      timestamp: 7,
      turnId: null,
      startedAt: null,
      blocks: [textBlock("b-1", 7)],
    });

    expect(project([legacy], [], null)).toEqual(["assistant:ts:7"]);
  });
});

describe("the steer split", () => {
  it("splits one turn into slice / steer / slice", () => {
    const steered = userMessage({ messageId: "m-steer", timestamp: 5 });
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [
        textBlock("b-1", 1),
        steerBlock("b-2", 5, "m-steer"),
        textBlock("b-3", 6),
      ],
    });

    // The steered user record is suppressed at top level and rendered nested,
    // under its own message id.
    expect(project([steered, turn], [], null)).toEqual([
      "assistant:t-1:part:0",
      "m-steer",
      "assistant:t-1:part:1",
    ]);
  });

  it("renames every slice of a turn once it splits - `split` is sticky", () => {
    const unsplit = planAssistantTurnRows([textBlock("b-1", 1)]);
    const split = planAssistantTurnRows([
      textBlock("b-1", 1),
      steerBlock("b-2", 2, "m-x"),
    ]);

    expect(unsplit.split).toBe(false);
    expect(split.split).toBe(true);
  });

  it("an orphaned steer block renders under its QUEUE ITEM, not a record", () => {
    // The block survives a checkpoint rewrite; the user row does not.
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [steerBlock("b-1", 2, "m-gone")],
    });

    expect(project([turn], [], null)).toEqual(["steer:q-b-1"]);
  });

  it("an empty turn still draws exactly one row", () => {
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [],
    });

    expect(project([turn], [], null)).toEqual(["assistant:t-1"]);
  });
});

describe("the stopped-turn trailing row", () => {
  it("adds a boundary row when a STOPPED turn ends on a steer", () => {
    // The row count of a turn depends on an EVENT here, not only on its
    // records - the case a messages-only enumeration cannot see.
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [textBlock("b-1", 1), steerBlock("b-2", 2, "m-gone")],
    });
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 11,
      messageId: null,
    });

    expect(project([turn], [stopped], null)).toEqual([
      "assistant:t-1:part:0",
      "steer:q-b-2",
      "assistant:t-1:part:1",
    ]);
  });

  it("adds NO boundary row when the same turn was not stopped", () => {
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [textBlock("b-1", 1), steerBlock("b-2", 2, "m-gone")],
    });

    expect(project([turn], [], null)).toEqual([
      "assistant:t-1:part:0",
      "steer:q-b-2",
    ]);
  });

  it("adds no boundary row to a stopped turn that already ends on an assistant slice", () => {
    const plan = planAssistantTurnRows([
      steerBlock("b-1", 1, "m-x"),
      textBlock("b-2", 2),
    ]);

    expect(
      assistantTurnNeedsTrailingRow({
        plan,
        turnComplete: true,
        stopped: true,
        hasRunState: false,
      }),
    ).toBe(false);
  });

  it("numbers the boundary row `part:0` for a STEER-ONLY stopped turn", () => {
    // The one shape where `nextChunkIndex` is 0: `planAssistantTurnRows` never
    // increments `chunkIndex` because the turn produced no slice at all. Every
    // other fixture here ends on "one more than the last slice", so the id
    // string is pinned rather than inferred - both the host projection and the
    // renderer read the same `nextChunkIndex`, which is exactly why an
    // equivalence assertion alone cannot see a change to it.
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [steerBlock("b-1", 2, "m-gone")],
    });
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 11,
      messageId: null,
    });

    expect(project([turn], [stopped], null)).toEqual([
      "steer:q-b-1",
      "assistant:t-1:part:0",
    ]);
  });

  it("adds no boundary row while the turn is still ACTIVE", () => {
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [steerBlock("b-1", 2, "m-gone")],
    });
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 11,
      messageId: null,
    });

    expect(project([turn], [stopped], "t-1")).toEqual(["steer:q-b-1"]);
  });
});

describe("stopped turns with no assistant record", () => {
  it("synthesizes a completed row when the Stop names a retained user message", () => {
    const user = userMessage({ messageId: "m-1", timestamp: 1 });
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 5,
      messageId: "m-1",
    });

    expect(project([user], [stopped], null)).toEqual(["m-1", "assistant:t-1"]);
  });

  it("synthesizes nothing when the Stop names a message no longer in the transcript", () => {
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 5,
      messageId: "m-branched-away",
    });

    expect(project([], [stopped], null)).toEqual([]);
  });

  it("synthesizes nothing when the turn DOES have a record - it folds instead", () => {
    const user = userMessage({ messageId: "m-1", timestamp: 1 });
    const turn = assistantMessage({
      messageId: "m-2",
      timestamp: 4,
      turnId: "t-1",
      startedAt: 2,
      blocks: [textBlock("b-1", 3)],
    });
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 5,
      messageId: "m-1",
    });

    expect(project([user, turn], [stopped], null)).toEqual([
      "m-1",
      "assistant:t-1",
    ]);
  });
});

describe("the sort key", () => {
  it("orders an assistant turn by startedAt, NOT by the record timestamp", () => {
    // `timestamp` is rewritten on every streaming delta. An old turn edited
    // late must stay where it was drawn.
    const early = assistantMessage({
      messageId: "m-1",
      timestamp: 9_000,
      turnId: "t-early",
      startedAt: 1,
      blocks: [textBlock("b-1", 1)],
    });
    const late = assistantMessage({
      messageId: "m-2",
      timestamp: 20,
      turnId: "t-late",
      startedAt: 10,
      blocks: [textBlock("b-2", 10)],
    });

    expect(project([early, late], [], null)).toEqual([
      "assistant:t-early",
      "assistant:t-late",
    ]);
  });

  it("falls back to the last non-suppressed user timestamp for a legacy record", () => {
    const user = userMessage({ messageId: "m-1", timestamp: 100 });
    const legacyTurn = assistantMessage({
      messageId: "m-2",
      timestamp: 500,
      turnId: "t-1",
      startedAt: null,
      blocks: [textBlock("b-1", 400)],
    });
    const laterUser = userMessage({ messageId: "m-3", timestamp: 200 });

    const rows = projectTranscriptRows({
      messages: [user, legacyTurn, laterUser],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    });

    // The turn anchors at 100 - the user record that preceded it in WALK
    // order - not at its own rewritten 500.
    const turnRow = rows.find((row) => row.rowId === "assistant:t-1");
    expect(turnRow?.createdAt).toBe(100);
  });

  it("gives every row of one turn the same createdAt, leaving order to sort stability", () => {
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 3,
      blocks: [
        textBlock("b-1", 4),
        steerBlock("b-2", 5, "m-gone"),
        textBlock("b-3", 6),
      ],
    });

    const rows = projectTranscriptRows({
      messages: [turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    });

    expect(rows.map((row) => row.createdAt)).toEqual([3, 3, 3]);
    expect(rows.map((row) => row.rowId)).toEqual([
      "assistant:t-1:part:0",
      "steer:q-b-2",
      "assistant:t-1:part:1",
    ]);
  });
});

describe("setup cards", () => {
  it("pins a genesis card (no creating event) to ordinal 0, ahead of an earlier message", () => {
    const user = userMessage({ messageId: "m-1", timestamp: 1 });
    // Back-filled: its stamp lands AFTER the first message.
    const genesis = setupEvent({
      eventId: "e-1",
      type: "setup.running",
      timestamp: 999,
      workspacePath: "/w",
    });

    expect(project([user], [genesis], null)).toEqual([
      "setup-card:chat-1:0:999",
      "m-1",
    ]);
  });

  it("weaves a mid-chat card immediately ABOVE its triggering message, by id not timestamp", () => {
    const user = userMessage({ messageId: "m-1", timestamp: 100 });
    const later = userMessage({ messageId: "m-2", timestamp: 300 });
    // Announced before the slow worktree add, so its stamp is BELOW m-1's...
    const creating = setupEvent({
      eventId: "e-1",
      type: "setup.creating",
      timestamp: 200,
      workspacePath: "/w",
      triggeringMessageId: "m-2",
    });

    // ...and it still renders directly above m-2, not between m-1 and m-2 by
    // timestamp - which is the same place here, so the ORDER below is what
    // distinguishes anchoring from sorting only in the next test.
    expect(project([user, later], [creating], null)).toEqual([
      "m-1",
      "setup-card:chat-1:0:200",
      "m-2",
    ]);
  });

  it("keeps an anchored card above its message even when its timestamp sorts it elsewhere", () => {
    const first = userMessage({ messageId: "m-1", timestamp: 100 });
    const second = userMessage({ messageId: "m-2", timestamp: 200 });
    // Timestamp AFTER m-2, anchor points at m-1: a sort would put the card
    // last, the weave puts it above m-1.
    const creating = setupEvent({
      eventId: "e-1",
      type: "setup.creating",
      timestamp: 900,
      workspacePath: "/w",
      triggeringMessageId: "m-1",
    });

    expect(project([first, second], [creating], null)).toEqual([
      "setup-card:chat-1:0:900",
      "m-1",
      "m-2",
    ]);
  });

  it("floats a card whose anchor was branched away, rather than dropping it", () => {
    const survivor = userMessage({ messageId: "m-2", timestamp: 300 });
    const creating = setupEvent({
      eventId: "e-1",
      type: "setup.creating",
      timestamp: 200,
      workspacePath: "/w",
      triggeringMessageId: "m-gone",
    });

    expect(project([survivor], [creating], null)).toEqual([
      "setup-card:chat-1:0:200",
      "m-2",
    ]);
  });
});

describe("event rows", () => {
  it("orders all fork links before all notification anchors for equal timestamps", () => {
    // The renderer concatenates its two event-row arrays in this order, so a
    // tie resolves this way and NOT in the event log's own order. Matching that
    // exactly is the point.
    const anchor = chatEventSchema.parse({
      eventId: "e-anchor",
      type: "send.failed",
      timestamp: 50,
      clientActionId: null,
      actor: null,
      message: "boom",
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "error",
      metadata: { notificationAnchor: true },
    });
    const fork = chatEventSchema.parse({
      eventId: "e-fork",
      type: "chat.forked",
      timestamp: 50,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: { sourceChatId: "c", sourceHostId: "h" },
    });

    expect(project([], [anchor, fork], null)).toEqual([
      "forked-chat-link:e-fork",
      "chat-event:e-anchor",
    ]);
  });

  it("gives an event that materializes no row no ordinal", () => {
    const started = chatEventSchema.parse({
      eventId: "e-1",
      type: "turn.started",
      timestamp: 5,
      clientActionId: null,
      actor: null,
      message: null,
      turnId: null,
      messageId: null,
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    });
    const user = userMessage({ messageId: "m-1", timestamp: 10 });

    expect(project([user], [started], null)).toEqual(["m-1"]);
  });
});

/**
 * A hydrated turn is only as good as the context that travels with it. These
 * pin the two ways a row under-reported what it needs - both of which surface
 * as a hydration that REPORTS SUCCESS and renders something poorer than the
 * legacy line drew, which is the quietest failure this system has.
 */
describe("what travels with a hydrated turn", () => {
  it("carries the pause lifecycle, including a resolution stamped with NO turn", () => {
    // `buildTurnPauseAccounting` subtracts the human's wait by pairing a
    // request with its resolution. The host stamps a resolution with
    // `activeTurn?.turnId ?? null`, so one landing after its turn settled
    // carries null - and an association keyed on `turnId` would ship the OPEN
    // without its CLOSE. The fold then drops the unclosed request entirely and
    // counts the whole human wait as agent execution time.
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [textBlock("b-1", 1)],
    });
    const requested = pauseEvent({
      eventId: "e-open",
      type: "approval.requested",
      timestamp: 2,
      turnId: "t-1",
      approvalId: "a-1",
      blockId: null,
    });
    const resolved = pauseEvent({
      eventId: "e-close",
      type: "approval.resolved",
      timestamp: 9,
      turnId: null,
      approvalId: "a-1",
      blockId: null,
    });

    expect(decoratingIdsOf([turn], [requested, resolved])).toEqual([
      "e-open",
      "e-close",
    ]);
  });

  it("carries an interview pause, which correlates on blockId rather than approvalId", () => {
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [textBlock("b-1", 1)],
    });
    const requested = pauseEvent({
      eventId: "e-open",
      type: "interview.requested",
      timestamp: 2,
      turnId: "t-1",
      approvalId: null,
      blockId: "blk-1",
    });
    const errored = pauseEvent({
      eventId: "e-close",
      type: "interview.errored",
      timestamp: 9,
      turnId: null,
      approvalId: null,
      blockId: "blk-1",
    });

    expect(decoratingIdsOf([turn], [requested, errored])).toEqual([
      "e-open",
      "e-close",
    ]);
  });

  it("leaves an orphaned resolution unassociated rather than guessing a turn", () => {
    // No open means nothing to subtract the wait from. Associating it with the
    // turn that happens to be running would attribute another turn's wait.
    const turn = assistantMessage({
      messageId: "m-1",
      timestamp: 10,
      turnId: "t-1",
      startedAt: 1,
      blocks: [textBlock("b-1", 1)],
    });
    const orphan = pauseEvent({
      eventId: "e-close",
      type: "approval.resolved",
      timestamp: 9,
      turnId: null,
      approvalId: "a-1",
      blockId: null,
    });

    expect(decoratingIdsOf([turn], [orphan])).toEqual([]);
  });

  it("names the user record a synthesized stopped row renders from", () => {
    // `renderStoppedTurnsWithoutAssistantRecords` emits NO model unless the
    // referenced message is present. A row served without it hydrates
    // "successfully" and draws nothing, while the span still counts it
    // hydrated - so the list suppresses its ordinal instead of leaving the
    // placeholder that would be retried.
    const user = userMessage({ messageId: "m-1", timestamp: 10 });
    const stopped = stoppedEvent({
      eventId: "e-1",
      turnId: "t-1",
      timestamp: 11,
      messageId: "m-1",
    });

    const row = projectTranscriptRows({
      messages: [user],
      events: [stopped],
      activeTurnId: null,
      chatId: "chat-1",
    }).find((candidate) => candidate.source.kind === "stopped-turn");
    if (row === undefined || row.source.kind !== "stopped-turn") {
      throw new Error("no stopped-turn row projected");
    }

    expect(row.source.triggeringMessageId).toBe("m-1");
  });
});

describe("assistantRowTurnKey", () => {
  /**
   * `TranscriptRowContext` is keyed by ROW id and a turn's context is shared by
   * every row the turn produces, so a renderer holding a turn key needs the
   * mapping in this direction. Pinned against the BUILDERS rather than against
   * literals: the point of the function is that the two cannot drift.
   */
  it("inverts the row-id builders for split and unsplit turns", () => {
    for (const turnKey of ["turn-1", "ts:1730000000000"]) {
      expect(assistantRowTurnKey(assistantRowId(turnKey))).toBe(turnKey);
      expect(assistantRowTurnKey(assistantSliceRowId(turnKey, 0, false))).toBe(
        turnKey,
      );
      for (const chunkIndex of [0, 3, 17]) {
        expect(
          assistantRowTurnKey(assistantSliceRowId(turnKey, chunkIndex, true)),
        ).toBe(turnKey);
      }
    }
  });

  it("declines every row id that does not name a turn", () => {
    expect(assistantRowTurnKey("m-1")).toBeNull();
    expect(assistantRowTurnKey("steer:queue-1")).toBeNull();
    expect(assistantRowTurnKey("setup-card:chat-1:0:5")).toBeNull();
    expect(assistantRowTurnKey("chat-event:e-1")).toBeNull();
  });
});

function checkpointEvent(fields: {
  eventId: string;
  turnId: string;
  timestamp: number;
  checkpointId: string;
  filePaths: readonly string[];
}): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.eventId,
    type: "checkpoint.captured",
    timestamp: fields.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: fields.turnId,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: {
      schemaVersion: 1,
      checkpointId: fields.checkpointId,
      capturingUserId: "u-1",
      capturingHostId: "h-1",
      allowedRoots: ["/w"],
      workingDirectory: "/w",
      capturedAt: fields.timestamp,
      entries: fields.filePaths.map((filePath) => ({
        filePath,
        operation: "edit" as const,
        // Distinct hashes: `isNoOpCheckpointEntry` treats an undoable entry
        // whose before/after agree as a no-op, and a no-op is excluded from
        // the overlap rule - so equal hashes here would make the fixture
        // assert nothing.
        beforeHash: `${filePath}:before`,
        afterHash: `${filePath}:after`,
        undoable: true,
        reason: null,
        artifact: null,
      })),
    },
  });
}

/**
 * The one derived value on a row that a WINDOW can silently invert.
 *
 * `hasLaterOverlappingChanges` answers "does a later turn rewrite a file this
 * checkpoint touches", and the renderer used to derive it from the events it
 * held. On the windowed line that is whatever is hydrated, so a span holding
 * the EARLIER turn and not the later one concludes `false` and the restore
 * dialog drops its warning that later turns' files will also be rewound - a
 * missing warning on an irreversible action.
 *
 * The projection sees whole history, so it answers once and carries it.
 */
describe("row context: whole-history checkpoint overlap", () => {
  const overlappingEvents: readonly ChatEvent[] = [
    checkpointEvent({
      eventId: "e-cp-1",
      turnId: "t-1",
      timestamp: 1_100,
      checkpointId: "cp-1",
      filePaths: ["/w/a.ts"],
    }),
    checkpointEvent({
      eventId: "e-cp-2",
      turnId: "t-2",
      timestamp: 2_100,
      checkpointId: "cp-2",
      filePaths: ["/w/a.ts"],
    }),
  ];

  const twoTurns: readonly Message[] = [
    userMessage({ messageId: "m-u1", timestamp: 1_000 }),
    assistantMessage({
      messageId: "m-a1",
      timestamp: 1_050,
      turnId: "t-1",
      startedAt: 1_000,
      blocks: [textBlock("b-1", 1_050)],
    }),
    userMessage({ messageId: "m-u2", timestamp: 2_000 }),
    assistantMessage({
      messageId: "m-a2",
      timestamp: 2_050,
      turnId: "t-2",
      startedAt: 2_000,
      blocks: [textBlock("b-2", 2_050)],
    }),
  ];

  function contextForTurn(
    events: readonly ChatEvent[],
    turnId: string,
  ): boolean | undefined {
    const rows = projectTranscriptRows({
      chatId: "c-1",
      messages: twoTurns,
      events,
      activeTurnId: null,
    });
    const row = rows.find(
      (candidate) =>
        candidate.source.kind === "assistant-slice" &&
        candidate.source.turnKey === turnId,
    );
    if (row === undefined) throw new Error(`no row for turn ${turnId}`);
    return row.context.hasLaterOverlappingChanges;
  }

  it("marks the EARLIER turn whose file a later checkpoint rewrites", () => {
    expect(contextForTurn(overlappingEvents, "t-1")).toBe(true);
  });

  it("leaves the LAST checkpoint unmarked - nothing comes after it", () => {
    // The discriminating half. A projection that marked every checkpoint in an
    // overlapping set would pass the assertion above while saying nothing about
    // the rule, since "later" is the entire content of it.
    expect(contextForTurn(overlappingEvents, "t-2")).toBeUndefined();
  });

  it("says nothing when the two turns touch DIFFERENT files", () => {
    const disjoint: readonly ChatEvent[] = [
      checkpointEvent({
        eventId: "e-cp-1",
        turnId: "t-1",
        timestamp: 1_100,
        checkpointId: "cp-1",
        filePaths: ["/w/a.ts"],
      }),
      checkpointEvent({
        eventId: "e-cp-2",
        turnId: "t-2",
        timestamp: 2_100,
        checkpointId: "cp-2",
        filePaths: ["/w/b.ts"],
      }),
    ];
    expect(contextForTurn(disjoint, "t-1")).toBeUndefined();
  });

  it("is ABSENT rather than false, so the renderer's own derivation still runs", () => {
    // The row-context contract: an absent field is the projection declining to
    // speak, never an assertion of `false`. A legacy peer holding the whole log
    // must keep deriving this for itself, and it can only do that if silence
    // stays distinguishable from a negative answer.
    const rows = projectTranscriptRows({
      chatId: "c-1",
      messages: twoTurns,
      events: overlappingEvents,
      activeTurnId: null,
    });
    const later = rows.find(
      (candidate) =>
        candidate.source.kind === "assistant-slice" &&
        candidate.source.turnKey === "t-2",
    );
    if (later === undefined) throw new Error("no row for t-2");
    expect(Object.hasOwn(later.context, "hasLaterOverlappingChanges")).toBe(
      false,
    );
  });
});
