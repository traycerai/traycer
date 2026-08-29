import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import {
  buildRowSkeleton,
  type TranscriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import {
  assistantRowId,
  assistantSliceRowId,
  projectTranscriptRows,
  type TranscriptRowDescriptor,
  type TranscriptRowProjectionInput,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  locateTranscriptRowOrdinal,
  type TranscriptRowLocator,
} from "@traycer/protocol/persistence/chat-transcript/locate-row";

/**
 * `locateTranscriptRowOrdinal` answers a cross-tile jump for the three target
 * kinds a windowed client cannot resolve on its own: a `block` (walking the
 * rendered segment tree), a `sent-message` (matching an `agentMessageSend`
 * enrichment), and a `message` naming an ASSISTANT record, whose rows are
 * turn-keyed and therefore never named by the durable id. The invariant these
 * tests exist to pin is that the ordinal it returns is an index into the SAME
 * enumeration `buildRowSkeleton` publishes - by construction, since both are
 * built from `projectTranscriptRows` - so every assertion here is phrased
 * against the skeleton, never against a hand-counted ordinal.
 */

const previewText: TranscriptPreviewProjection = (content: JsonContent) =>
  content.text ?? "";

function humanUserMessage(fields: {
  messageId: string;
  timestamp: number;
  text: string;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "text", text: fields.text } },
    timestamp: fields.timestamp,
    sessionAnchor: null,
  });
}

/**
 * An assistant turn built from raw block shapes, parsed through
 * `messageSchema` so every defaulted field (`agentMessageSend`,
 * `parentBlockId`, `imageResults`, ...) is filled the way a real persisted
 * record would be - mirrors `build-skeleton.test.ts`'s own fixtures.
 */
function assistantMessageWithBlocks(fields: {
  readonly messageId: string;
  readonly timestamp: number;
  readonly turnId: string | null;
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
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
    startedAt: null,
    timestamp: fields.timestamp,
    turnId: fields.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}

/** Resolves a locator or fails the test - every case below expects a hit. */
function locateOrThrow(
  rows: readonly TranscriptRowDescriptor[],
  messages: readonly Message[],
  locator: TranscriptRowLocator,
): number {
  const ordinal = locateTranscriptRowOrdinal({ rows, messages }, locator);
  if (ordinal === null) throw new Error("expected an ordinal");
  return ordinal;
}

describe("locateTranscriptRowOrdinal resolves into the same enumeration buildRowSkeleton publishes", () => {
  it("rows and skeleton agree on length and row id at every ordinal, including one a locator resolves", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "hi",
    });
    const steered = humanUserMessage({
      messageId: "m-steer",
      timestamp: 5,
      text: "also do y",
    });
    const turn = assistantMessageWithBlocks({
      messageId: "m-turn",
      timestamp: 10,
      turnId: "turn-x",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-a",
          status: "completed",
          timestamp: 6,
          toolName: "Read",
          error: null,
        },
        {
          type: "steer",
          blockId: "b-steer",
          status: "completed",
          timestamp: 7,
          queueItemId: "q-1",
          messageId: "m-steer",
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
        {
          type: "tool_call",
          blockId: "tc-b",
          status: "completed",
          timestamp: 8,
          toolName: "Write",
          error: null,
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [human, steered, turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    expect(rows.length).toBe(skeleton.length);
    expect(rows.map((row) => row.rowId)).toEqual(
      skeleton.map((entry) => entry.rowId),
    );

    for (const blockId of ["tc-a", "b-steer", "tc-b"]) {
      const ordinal = locateOrThrow(rows, input.messages, {
        kind: "block",
        blockId,
      });
      expect(rows[ordinal]?.rowId).toBe(skeleton[ordinal]?.rowId);
    }
  });
});

describe("locateTranscriptRowOrdinal: block targets", () => {
  it("resolves a block on a plain, unsplit assistant turn", () => {
    const human = humanUserMessage({
      messageId: "m-1",
      timestamp: 1,
      text: "go",
    });
    const assistant = assistantMessageWithBlocks({
      messageId: "m-2",
      timestamp: 2,
      turnId: "turn-1",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-1",
          status: "completed",
          timestamp: 2,
          toolName: "Bash",
          error: null,
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [human, assistant],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    const ordinal = locateOrThrow(rows, input.messages, {
      kind: "block",
      blockId: "tc-1",
    });

    expect(skeleton[ordinal]?.rowId).toBe(assistantRowId("turn-1"));
  });

  it("resolves a block in a LATER slice of a turn split by a steer, not the first slice", () => {
    // A naive "first assistant row of the turn" answer would land on
    // `tc-early`'s slice instead - the split is exactly what makes that wrong.
    const steered = humanUserMessage({
      messageId: "m-steer",
      timestamp: 5,
      text: "wait, also do y",
    });
    const turn = assistantMessageWithBlocks({
      messageId: "m-turn",
      timestamp: 10,
      turnId: "turn-2",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-early",
          status: "completed",
          timestamp: 6,
          toolName: "Read",
          error: null,
        },
        {
          type: "steer",
          blockId: "b-steer",
          status: "completed",
          timestamp: 7,
          queueItemId: "q-1",
          messageId: "m-steer",
          content: { type: "doc" },
          mode: "safe_point",
          sender: null,
        },
        {
          type: "tool_call",
          blockId: "tc-late",
          status: "completed",
          timestamp: 8,
          toolName: "Write",
          error: null,
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [steered, turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    const lateOrdinal = locateOrThrow(rows, input.messages, {
      kind: "block",
      blockId: "tc-late",
    });
    const earlyOrdinal = locateOrThrow(rows, input.messages, {
      kind: "block",
      blockId: "tc-early",
    });

    expect(skeleton[lateOrdinal]?.rowId).toBe(
      assistantSliceRowId("turn-2", 1, true),
    );
    expect(skeleton[earlyOrdinal]?.rowId).toBe(
      assistantSliceRowId("turn-2", 0, true),
    );
    expect(lateOrdinal).not.toBe(earlyOrdinal);
  });

  it("resolves a nested tool_call block (parentBlockId -> a subagent card) to the row that renders its parent", () => {
    // Blocks are persisted FLAT on the message - the nesting is a
    // rendering-time grouping - so the nested block must resolve to the row
    // that renders its parent's card without walking `parentBlockId` at all.
    const turn = assistantMessageWithBlocks({
      messageId: "m-turn-3",
      timestamp: 20,
      turnId: "turn-3",
      blocks: [
        {
          type: "subagent",
          blockId: "sa-1",
          status: "completed",
          timestamp: 20,
          name: "Explorer",
          task: "look around",
          progressUpdates: [],
          result: "done",
        },
        {
          type: "tool_call",
          blockId: "tc-nested",
          status: "completed",
          timestamp: 21,
          toolName: "Read",
          error: null,
          parentBlockId: "sa-1",
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    const parentOrdinal = locateOrThrow(rows, input.messages, {
      kind: "block",
      blockId: "sa-1",
    });
    const nestedOrdinal = locateOrThrow(rows, input.messages, {
      kind: "block",
      blockId: "tc-nested",
    });

    expect(nestedOrdinal).toBe(parentOrdinal);
    expect(skeleton[nestedOrdinal]?.rowId).toBe(assistantRowId("turn-3"));
  });

  it("returns null for a block id that does not exist", () => {
    const turn = assistantMessageWithBlocks({
      messageId: "m-turn-6",
      timestamp: 50,
      turnId: "turn-6",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-1",
          status: "completed",
          timestamp: 50,
          toolName: "Bash",
          error: null,
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);

    expect(
      locateTranscriptRowOrdinal(
        { rows, messages: input.messages },
        { kind: "block", blockId: "does-not-exist" },
      ),
    ).toBeNull();
  });
});

describe("locateTranscriptRowOrdinal: sent-message targets", () => {
  it("resolves to the tool_call block whose agentMessageSend matches receiver and verbatim text", () => {
    const turn = assistantMessageWithBlocks({
      messageId: "m-turn-4",
      timestamp: 30,
      turnId: "turn-4",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-send",
          status: "completed",
          timestamp: 30,
          toolName: "SendMessage",
          error: null,
          startedAt: 30,
          agentMessageSend: {
            receiverAgentId: "agent-recv",
            message: "please review PR 42",
            responseId: null,
            expectReply: false,
          },
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    const ordinal = locateOrThrow(rows, input.messages, {
      kind: "sent-message",
      receiverAgentId: "agent-recv",
      messageText: "please review PR 42",
      timestamp: 30,
    });

    expect(skeleton[ordinal]?.rowId).toBe(assistantRowId("turn-4"));
  });

  it("breaks a tie between two matching sends by the one nearest the target timestamp", () => {
    // Two DIFFERENT turns so the winning block is observable at the row
    // level: if both candidates folded into one row this could not
    // distinguish "picked the nearest" from "picked either".
    const far = assistantMessageWithBlocks({
      messageId: "m-far",
      timestamp: 40,
      turnId: "turn-far",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-far",
          status: "completed",
          timestamp: 40,
          toolName: "SendMessage",
          error: null,
          startedAt: 100,
          agentMessageSend: {
            receiverAgentId: "agent-recv",
            message: "ping",
            responseId: null,
            expectReply: false,
          },
        },
      ],
    });
    const near = assistantMessageWithBlocks({
      messageId: "m-near",
      timestamp: 41,
      turnId: "turn-near",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-near",
          status: "completed",
          timestamp: 41,
          toolName: "SendMessage",
          error: null,
          startedAt: 205,
          agentMessageSend: {
            receiverAgentId: "agent-recv",
            message: "ping",
            responseId: null,
            expectReply: false,
          },
        },
      ],
    });
    // `far` listed FIRST: proves the winner is picked by distance, not by
    // "first match wins" - `far` is first and still loses.
    const input: TranscriptRowProjectionInput = {
      messages: [far, near],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    // |205 - 200| = 5 beats |100 - 200| = 100.
    const ordinal = locateOrThrow(rows, input.messages, {
      kind: "sent-message",
      receiverAgentId: "agent-recv",
      messageText: "ping",
      timestamp: 200,
    });

    expect(skeleton[ordinal]?.rowId).toBe(assistantRowId("turn-near"));
    expect(skeleton[ordinal]?.rowId).not.toBe(assistantRowId("turn-far"));
  });

  it("returns null for a sent-message target whose text matches nothing", () => {
    const turn = assistantMessageWithBlocks({
      messageId: "m-turn-7",
      timestamp: 60,
      turnId: "turn-7",
      blocks: [
        {
          type: "tool_call",
          blockId: "tc-send-7",
          status: "completed",
          timestamp: 60,
          toolName: "SendMessage",
          error: null,
          agentMessageSend: {
            receiverAgentId: "agent-recv",
            message: "hello",
            responseId: null,
            expectReply: false,
          },
        },
      ],
    });
    const input: TranscriptRowProjectionInput = {
      messages: [turn],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
    const rows = projectTranscriptRows(input);

    expect(
      locateTranscriptRowOrdinal(
        { rows, messages: input.messages },
        {
          kind: "sent-message",
          receiverAgentId: "agent-recv",
          messageText: "nothing matches this",
          timestamp: 60,
        },
      ),
    ).toBeNull();
  });
});

describe("locateTranscriptRowOrdinal: message targets", () => {
  /**
   * One human turn, one steer, one assistant turn split by it. Enough to make
   * every distinction this locator has to draw: a user row named by its own id,
   * a steer row named by the record it steered, and an assistant record that
   * names TWO rows and no row id at all.
   */
  function splitTurnTranscript(): TranscriptRowProjectionInput {
    return {
      messages: [
        humanUserMessage({ messageId: "m-1", timestamp: 1, text: "go" }),
        humanUserMessage({
          messageId: "m-steer",
          timestamp: 5,
          text: "also do y",
        }),
        assistantMessageWithBlocks({
          messageId: "m-turn",
          timestamp: 10,
          turnId: "turn-1",
          blocks: [
            {
              type: "tool_call",
              blockId: "tc-early",
              status: "completed",
              timestamp: 6,
              toolName: "Read",
              error: null,
            },
            {
              type: "steer",
              blockId: "b-steer",
              status: "completed",
              timestamp: 7,
              queueItemId: "q-1",
              messageId: "m-steer",
              content: { type: "doc" },
              mode: "safe_point",
              sender: null,
            },
            {
              type: "tool_call",
              blockId: "tc-late",
              status: "completed",
              timestamp: 8,
              toolName: "Write",
              error: null,
            },
          ],
        }),
      ],
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    };
  }

  it("resolves an ASSISTANT record, whose rows no id-as-row-id read can find", () => {
    // The whole reason this kind exists. `m-turn` is not a row id anywhere in
    // the skeleton, so a client looking it up there waits forever.
    const input = splitTurnTranscript();
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);
    expect(skeleton.map((entry) => entry.rowId)).not.toContain("m-turn");

    const ordinal = locateOrThrow(rows, input.messages, {
      kind: "message",
      messageId: "m-turn",
    });

    // The TRAILING slice, matching the client's own `messageIdForTranscriptTarget`:
    // a completion or failure notification describes the terminal edge of the
    // record, and the two resolvers must not disagree about which row that is.
    expect(skeleton[ordinal]?.rowId).toBe(
      assistantSliceRowId("turn-1", 1, true),
    );
  });

  it("resolves a USER record to its own row", () => {
    const input = splitTurnTranscript();
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    const ordinal = locateOrThrow(rows, input.messages, {
      kind: "message",
      messageId: "m-1",
    });

    expect(skeleton[ordinal]?.rowId).toBe("m-1");
  });

  it("resolves a STEERED record to its steer row, not to the turn that names it", () => {
    // `m-steer` appears in `steeredMessageIds` on every slice of the turn, so a
    // search that matched anywhere the id occurs would answer with an assistant
    // slice - and jump the reader past the bubble they asked for.
    const input = splitTurnTranscript();
    const rows = projectTranscriptRows(input);
    const skeleton = buildRowSkeleton(input, previewText);

    const ordinal = locateOrThrow(rows, input.messages, {
      kind: "message",
      messageId: "m-steer",
    });

    expect(skeleton[ordinal]?.rowId).toBe("m-steer");
  });

  it("returns null for a record the transcript no longer holds", () => {
    const input = splitTurnTranscript();
    const rows = projectTranscriptRows(input);

    expect(
      locateTranscriptRowOrdinal(
        { rows, messages: input.messages },
        { kind: "message", messageId: "m-trimmed-by-a-restore" },
      ),
    ).toBeNull();
  });
});
