import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  coldJumpOrdinal,
  hostLocatorForJumpTarget,
  receiptAnchorBlockId,
} from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import type {
  ChatMessage,
  MessageSegment,
  SubagentSegment,
  ToolSegment,
} from "@/stores/composer/chat-store";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * Which cross-tile jump targets this client can place, and which it must ask
 * the host about.
 *
 * The case these exist for is a `message` target naming an ASSISTANT record.
 * Its rows are turn-keyed (`assistant:<turnKey>`), so the durable id is not a
 * row id and the skeleton read misses; the rendered model carries it as
 * `persistentMessageId`, which a COLD row does not have. Both client reads
 * therefore miss on exactly the rows a jump is most likely to land on in a long
 * chat, and without a host answer the jump parks until its TTL drops it.
 */

function skeletonEntry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role: "user",
    byteLength: 64,
    bodyDigest: `d-${rowId}`,
  };
}

function windowNaming(rowIds: readonly string[]): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    epoch: 1,
    rowCount: rowIds.length,
    skeleton: rowIds.map((rowId, ordinal) => skeletonEntry(rowId, ordinal)),
    skeletonComplete: true,
    skeletonStreamCoveredThrough: rowIds.length,
  };
}

/** Only the two fields either resolver reads; the rest is inert scaffolding. */
function renderedRow(input: {
  readonly id: string;
  readonly persistentMessageId: string | null;
}): ChatMessage {
  return {
    id: input.id,
    role: "assistant",
    content: "",
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: input.persistentMessageId,
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

/** Only the fields either resolver reads; the rest is inert scaffolding. */
function toolSegment(input: {
  readonly id: string;
  readonly agentMessageReceipt: { readonly messageId: string } | null;
}): ToolSegment {
  return {
    id: input.id,
    kind: "tool",
    toolName: "traycer_send_message",
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt:
      input.agentMessageReceipt === null
        ? null
        : {
            receiverAgentId: "receiver-1",
            messageId: input.agentMessageReceipt.messageId,
          },
    isStreaming: false,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: null,
    startedAt: 0,
    durationMs: null,
    parentId: null,
    imageResults: [],
  };
}

function subagentSegment(input: {
  readonly id: string;
  readonly children: ReadonlyArray<ToolSegment>;
}): SubagentSegment {
  return {
    id: input.id,
    kind: "subagent",
    name: null,
    agentType: null,
    task: null,
    progressUpdates: [],
    result: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId: null,
    workflowMeta: null,
    children: input.children,
  };
}

function messageWithSegments(
  id: string,
  segments: ReadonlyArray<MessageSegment>,
): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    segments,
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
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

describe("receiptAnchorBlockId", () => {
  it("finds a top-level tool segment whose receipt names the message", () => {
    const messages = [
      messageWithSegments("m-1", [
        toolSegment({ id: "block-1", agentMessageReceipt: null }),
        toolSegment({
          id: "block-2",
          agentMessageReceipt: { messageId: "m-received" },
        }),
      ]),
    ];

    expect(receiptAnchorBlockId(messages, "m-received")).toBe("block-2");
  });

  it("finds a receipt nested inside a subagent card's children", () => {
    const messages = [
      messageWithSegments("m-1", [
        subagentSegment({
          id: "subagent-1",
          children: [
            toolSegment({
              id: "nested-block",
              agentMessageReceipt: { messageId: "m-received" },
            }),
          ],
        }),
      ]),
    ];

    expect(receiptAnchorBlockId(messages, "m-received")).toBe("nested-block");
  });

  it("returns null when no rendered tool segment carries the receipt", () => {
    const messages = [
      messageWithSegments("m-1", [
        toolSegment({
          id: "block-1",
          agentMessageReceipt: { messageId: "some-other-message" },
        }),
      ]),
    ];

    expect(receiptAnchorBlockId(messages, "m-received")).toBeNull();
  });
});

describe("hostLocatorForJumpTarget: a `receipt` target", () => {
  it("asks the host when no rendered tool segment carries the receipt", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "receipt", messageId: "m-received" },
      transcriptWindow: windowNaming(["m-1"]),
      messages: [],
    });

    expect(locator).toEqual({ kind: "receipt", messageId: "m-received" });
  });

  it("does NOT ask once the send block carrying the receipt is rendered", () => {
    const messages = [
      messageWithSegments("m-1", [
        toolSegment({
          id: "block-1",
          agentMessageReceipt: { messageId: "m-received" },
        }),
      ]),
    ];

    const locator = hostLocatorForJumpTarget({
      target: { kind: "receipt", messageId: "m-received" },
      transcriptWindow: windowNaming(["m-1"]),
      messages,
    });

    expect(locator).toBeNull();
  });

  it("asks for nothing on the legacy line, which holds the whole transcript", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "receipt", messageId: "m-received" },
      transcriptWindow: null,
      messages: [],
    });

    expect(locator).toBeNull();
  });
});

describe("coldJumpOrdinal: a `receipt` target", () => {
  const window = windowNaming(["m-1", "m-2"]);

  it("returns the host's answer, mirroring `block` and `sent-message`", () => {
    expect(
      coldJumpOrdinal(window, { kind: "receipt", messageId: "m-received" }, 1),
    ).toBe(1);
  });

  it("stays null while the host has not answered", () => {
    expect(
      coldJumpOrdinal(
        window,
        { kind: "receipt", messageId: "m-received" },
        null,
      ),
    ).toBeNull();
  });
});

describe("hostLocatorForJumpTarget: a `message` target", () => {
  it("asks the host for an assistant record whose turn-keyed rows are cold", () => {
    // The skeleton names the turn's rows, not the record - and nothing is
    // hydrated, so there is no `persistentMessageId` to match either.
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [],
    });

    expect(locator).toEqual({ kind: "message", messageId: "m-turn" });
  });

  it("does NOT ask for a cold USER row, whose row id is its message id", () => {
    // The common case. The skeleton alone places it, so a request here would be
    // a round trip whose answer `coldJumpOrdinal` never reads.
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-1" },
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [],
    });

    expect(locator).toBeNull();
  });

  it("does NOT ask once the assistant row is hydrated and carries the durable id", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [
        renderedRow({ id: "assistant:turn-1", persistentMessageId: "m-turn" }),
      ],
    });

    expect(locator).toBeNull();
  });

  it("asks for nothing on the legacy line, which holds the whole transcript", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: null,
      messages: [],
    });

    expect(locator).toBeNull();
  });
});

describe("coldJumpOrdinal: a `message` target", () => {
  const window = windowNaming(["m-1", "assistant:turn-1", "m-2"]);

  it("falls through to the host's answer when the skeleton does not name the id", () => {
    // Without the fallback this is `null` forever: the record is an assistant
    // one, so no skeleton entry will ever carry its id however long the jump
    // waits.
    expect(
      coldJumpOrdinal(window, { kind: "message", messageId: "m-turn" }, 1),
    ).toBe(1);
  });

  it("prefers the skeleton, so a placed row does not wait on an RPC", () => {
    expect(
      coldJumpOrdinal(window, { kind: "message", messageId: "m-2" }, 99),
    ).toBe(2);
  });

  it("stays null while neither the skeleton nor the host has an answer", () => {
    expect(
      coldJumpOrdinal(window, { kind: "message", messageId: "m-turn" }, null),
    ).toBeNull();
  });
});
