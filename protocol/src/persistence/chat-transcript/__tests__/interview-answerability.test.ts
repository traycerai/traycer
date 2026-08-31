import { describe, expect, it } from "vitest";
import {
  interviewBlockSchema,
  type ContentBlock,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { judgeInterviewAnswerability } from "@traycer/protocol/persistence/chat-transcript/interview-answerability";
import { contentBlocksById } from "@traycer/protocol/persistence/chat-transcript/pinned-todo-fold";
import {
  projectTranscriptRows,
  type TranscriptRowDescriptor,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import {
  assistantMessageSchema,
  userMessageSchema,
  type AssistantMessage,
  type Message,
  type UserMessage,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * The host's answer to "is this pending question askable, and where".
 *
 * What is worth pinning here is every way the answer can be WRONG in the
 * direction that hurts: a `null` ordinal is what re-enables the destructive
 * dismiss affordance, so each of these asserts which of the three states the
 * judgement lands in - placed, unrenderable, or (by omission) unjudged.
 */

const AGENT_SENDER = {
  type: "agent" as const,
  harnessId: "claude",
  agentId: "agent-1",
  displayName: "Claude",
};

const USER_SENDER = { type: "user" as const, userId: "user-1" };

const NO_EVENTS: readonly ChatEvent[] = [];

function interviewBlock(
  blockId: string,
  status: "streaming" | "completed" | "errored",
): ContentBlock {
  return interviewBlockSchema.parse({
    blockId,
    status,
    timestamp: 1,
    type: "interview",
    toolName: "AskUserQuestion",
    title: "Pick one",
    description: null,
    questions: [],
    answers: [],
    error: null,
    metadata: null,
  });
}

function steerBlock(blockId: string, timestamp: number): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "steer" as const,
    queueItemId: `q-${blockId}`,
    messageId: `m-${blockId}`,
    content: { type: "doc" },
    mode: "safe_point" as const,
    sender: null,
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  turnId: string;
  blocks: ReadonlyArray<ContentBlock>;
}): AssistantMessage {
  return assistantMessageSchema.parse({
    role: "assistant",
    messageId: input.messageId,
    sender: AGENT_SENDER,
    blocks: input.blocks,
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
  });
}

function userMessage(messageId: string, timestamp: number): UserMessage {
  return userMessageSchema.parse({
    role: "user",
    messageId,
    sender: USER_SENDER,
    message: { kind: "user", content: { type: "doc" } },
    timestamp,
    sessionAnchor: null,
  });
}

/**
 * The projection the host feeds this judgement, built the way
 * `chat-transcript-view.ts` builds it.
 *
 * Going through `projectTranscriptRows` rather than hand-writing descriptors is
 * the point: the ORDINALS these tests assert are the projection's own indices,
 * so a change to how a turn splits into rows moves them here too.
 */
function rowsFor(
  messages: readonly Message[],
  activeTurnId: string | null,
): readonly TranscriptRowDescriptor[] {
  return projectTranscriptRows({
    messages,
    events: NO_EVENTS,
    activeTurnId,
    chatId: "chat-1",
  });
}

describe("judgeInterviewAnswerability", () => {
  it("names the ordinal of the row that renders a streaming question", () => {
    const messages = [
      userMessage("u-1", 1),
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [interviewBlock("ask-1", "streaming")],
      }),
    ];

    expect(
      judgeInterviewAnswerability(
        rowsFor(messages, "turn-1"),
        contentBlocksById(messages),
        ["ask-1"],
      ),
    ).toEqual([{ blockId: "ask-1", ordinal: 1 }]);
  });

  it("reports a settled block as unrenderable, which is the phantom-interview shape", () => {
    // The harness errored the AskUserQuestion and the block persisted as
    // `errored`, but the pending wait was rebuilt from a dangling
    // `interview.requested`. Nothing will ever draw a card, and the dismiss
    // affordance is the only way out of the chat - so this MUST stay `null`.
    const messages = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [interviewBlock("ask-1", "errored")],
      }),
    ];

    expect(
      judgeInterviewAnswerability(
        rowsFor(messages, null),
        contentBlocksById(messages),
        ["ask-1"],
      ),
    ).toEqual([{ blockId: "ask-1", ordinal: null }]);
  });

  it("reports a block the transcript never recorded as unrenderable", () => {
    // The hard-crash shape: the row never persisted, so the question exists
    // only as a pending wait.
    expect(
      judgeInterviewAnswerability(rowsFor([], null), new Map(), ["ghost"]),
    ).toEqual([{ blockId: "ghost", ordinal: null }]);
  });

  it("reports a streaming block NO ROW declares as unrenderable", () => {
    // The contract that makes the row walk load-bearing rather than a stylistic
    // choice: an ordinal is only ever returned for a row that names the block,
    // so a block present in the RECORDS but declared by no row is `null`. A
    // records walk would call it answerable and hand the client an id it has
    // nowhere to send - hydration is addressed by ordinal, and there is none.
    //
    // The rows are hand-built rather than projected precisely because this pins
    // the function's own contract; whether today's projection can produce such
    // a block is a separate question, and the client is stuck either way.
    const messages = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [interviewBlock("ask-1", "streaming")],
      }),
    ];
    const rowsWithoutTheBlock: readonly TranscriptRowDescriptor[] = rowsFor(
      messages,
      null,
    ).map((row) =>
      row.source.kind === "assistant-slice"
        ? { ...row, source: { ...row.source, blockIds: [] } }
        : row,
    );

    expect(
      judgeInterviewAnswerability(
        rowsWithoutTheBlock,
        contentBlocksById(messages),
        ["ask-1"],
      ),
    ).toEqual([{ blockId: "ask-1", ordinal: null }]);
  });

  it("never names a row that does not declare the block", () => {
    // The same contract stated as an invariant over a realistic projection: a
    // returned ordinal must be a row the client can hydrate INTO a card.
    const messages = [
      userMessage("u-1", 1),
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [
          steerBlock("steer-1", 2),
          interviewBlock("ask-1", "streaming"),
        ],
      }),
    ];
    const rows = rowsFor(messages, null);

    for (const entry of judgeInterviewAnswerability(
      rows,
      contentBlocksById(messages),
      ["ask-1"],
    )) {
      if (entry.ordinal === null) continue;
      const source = rows[entry.ordinal]?.source;
      expect(source?.kind).toBe("assistant-slice");
      expect(
        source?.kind === "assistant-slice" ? source.blockIds : [],
      ).toContain(entry.blockId);
    }
  });

  it("returns one entry per pending id, in the order it was given them", () => {
    // The client reads a MISSING entry as "not judged", so the result has to
    // cover the whole pending set even when most of it is unrenderable.
    const messages = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [interviewBlock("ask-1", "streaming")],
      }),
      userMessage("u-1", 3),
      assistantMessage({
        messageId: "a-2",
        timestamp: 4,
        turnId: "turn-2",
        blocks: [interviewBlock("ask-2", "streaming")],
      }),
    ];

    expect(
      judgeInterviewAnswerability(
        rowsFor(messages, null),
        contentBlocksById(messages),
        ["ask-2", "missing", "ask-1"],
      ),
    ).toEqual([
      { blockId: "ask-2", ordinal: 2 },
      { blockId: "missing", ordinal: null },
      { blockId: "ask-1", ordinal: 0 },
    ]);
  });

  it("judges nothing when nothing is pending", () => {
    // The overwhelmingly common case, and the one that must not walk the
    // transcript: this runs on every snapshot of every chat.
    const messages = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [interviewBlock("ask-1", "streaming")],
      }),
    ];

    expect(
      judgeInterviewAnswerability(
        rowsFor(messages, null),
        contentBlocksById(messages),
        [],
      ),
    ).toEqual([]);
  });

  it("ignores a pending id that names a block of another type", () => {
    // Not defensive noise: block ids are unique across the transcript, so a
    // pending interview id colliding with a `steer` block would otherwise
    // resolve to that block's row and hydrate the wrong ordinal.
    const messages = [
      assistantMessage({
        messageId: "a-1",
        timestamp: 2,
        turnId: "turn-1",
        blocks: [steerBlock("ask-1", 2)],
      }),
    ];

    expect(
      judgeInterviewAnswerability(
        rowsFor(messages, null),
        contentBlocksById(messages),
        ["ask-1"],
      ),
    ).toEqual([{ blockId: "ask-1", ordinal: null }]);
  });
});
