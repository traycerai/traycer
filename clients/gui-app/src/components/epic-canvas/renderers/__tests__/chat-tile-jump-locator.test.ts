import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  coldJumpOrdinal,
  hostLocatorForJumpTarget,
  isComposerPendingApproval,
  isStreamingInterviewBlock,
  landingBlockIdForJumpTarget,
  planSegmentIdForApproval,
  receiptAnchorBlockId,
  resolveApprovalJumpLanding,
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
  readonly agentMessageSend?: {
    readonly receiverAgentId: string;
    readonly message: string;
  };
}): ToolSegment {
  return {
    id: input.id,
    kind: "tool",
    toolName: "traycer_send_message",
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend:
      input.agentMessageSend === undefined
        ? null
        : {
            receiverAgentId: input.agentMessageSend.receiverAgentId,
            message: input.agentMessageSend.message,
            responseId: null,
            expectReply: false,
          },
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

describe("isStreamingInterviewBlock", () => {
  it("is true only for a streaming interview with that block id", () => {
    const messages = [
      messageWithSegments("m-1", [
        {
          id: "q1:interview",
          kind: "interview",
          status: "streaming",
          toolName: "AskUserQuestion",
          questions: [],
          answers: [],
          draftAnswers: [],
          outcome: null,
          settlement: null,
          error: null,
          delivery: null,
          forkedWithoutAnswer: false,
        },
      ]),
    ];

    expect(isStreamingInterviewBlock(messages, "q1:interview")).toBe(true);
    expect(isStreamingInterviewBlock(messages, "other")).toBe(false);
  });
});

describe("hostLocatorForJumpTarget: a pending-interview `block` target", () => {
  it("does not ask the host when the composer already holds that interview", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "block", blockId: "q1:interview" },
      transcriptWindow: windowNaming(["assistant:turn-1"]),
      messages: [],
      pendingInterviewBlockId: "q1:interview",
    });

    expect(locator).toBeNull();
  });

  it("does not ask the host when the block is a streaming interview segment", () => {
    const messages = [
      messageWithSegments("m-1", [
        {
          id: "q1:interview",
          kind: "interview",
          status: "streaming",
          toolName: "AskUserQuestion",
          questions: [],
          answers: [],
          draftAnswers: [],
          outcome: null,
          settlement: null,
          error: null,
          delivery: null,
          forkedWithoutAnswer: false,
        },
      ]),
    ];

    const locator = hostLocatorForJumpTarget({
      target: { kind: "block", blockId: "q1:interview" },
      transcriptWindow: windowNaming(["m-1"]),
      messages,
      pendingInterviewBlockId: null,
    });

    expect(locator).toBeNull();
  });

  it("asks the host for a cold non-interview block", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "block", blockId: "tool-1" },
      transcriptWindow: windowNaming(["assistant:turn-1"]),
      messages: [],
      pendingInterviewBlockId: "q1:interview",
    });

    expect(locator).toEqual({ kind: "block", blockId: "tool-1" });
  });
});

describe("isComposerPendingApproval", () => {
  it("matches tool approvals in the composer queue and ignores plan approvals", () => {
    const tool = {
      approvalId: "tool-1",
      toolName: "Bash",
      description: "run",
      input: null,
      requestedAt: 1,
      kind: "tool" as const,
      planId: null,
      actions: [],
    };
    const plan = {
      approvalId: "plan-1",
      toolName: "plan",
      description: "implement",
      input: null,
      requestedAt: 1,
      kind: "plan" as const,
      planId: "p1",
      actions: [],
    };
    expect(isComposerPendingApproval([tool, plan], [], "tool-1")).toBe(true);
    expect(isComposerPendingApproval([tool, plan], [], "plan-1")).toBe(false);
  });

  it("matches a pending file-edit approval", () => {
    const fileEdit = {
      approvalId: "file-1",
      toolName: "Edit",
      description: "edit",
      paths: ["a.ts"],
      operation: "edit" as const,
      input: null,
      requestedAt: 1,
    };
    expect(isComposerPendingApproval([], [fileEdit], "file-1")).toBe(true);
    expect(isComposerPendingApproval([], [fileEdit], "missing")).toBe(false);
  });
});

describe("planSegmentIdForApproval", () => {
  it("returns the plan segment id that carries the approval", () => {
    const messages = [
      messageWithSegments("m-1", [
        {
          id: "plan-block",
          kind: "plan",
          planId: "p1",
          planStatus: "awaiting_approval",
          harnessId: "claude",
          source: {
            harnessId: "claude",
            sessionId: "s1",
            turnId: "t1",
            kind: "approval-plan",
          },
          title: "Plan",
          summary: null,
          markdownPreview: "",
          fullContentRef: null,
          steps: [],
          actions: [],
          approvalId: "approval-plan",
          supersededByPlanId: null,
          isStreaming: false,
          contentIdentity: "id",
        },
      ]),
    ];
    expect(planSegmentIdForApproval(messages, "approval-plan")).toBe(
      "plan-block",
    );
    expect(planSegmentIdForApproval(messages, "other")).toBeNull();
  });
});

describe("resolveApprovalJumpLanding", () => {
  const toolApproval = {
    approvalId: "tool-1",
    toolName: "Bash",
    description: "run",
    input: null,
    requestedAt: 1,
    kind: "tool" as const,
    planId: null,
    actions: [],
  };
  const fileEdit = {
    approvalId: "file-1",
    toolName: "Edit",
    description: "edit",
    paths: ["a.ts"],
    operation: "edit" as const,
    input: null,
    requestedAt: 1,
  };

  it("lands on the composer for a visible tool or file-edit approval", () => {
    expect(
      resolveApprovalJumpLanding({
        approvalId: "tool-1",
        pendingApprovals: [toolApproval],
        pendingFileEditApprovals: [],
        messages: [],
      }),
    ).toEqual({ kind: "composer", approvalId: "tool-1" });
    expect(
      resolveApprovalJumpLanding({
        approvalId: "file-1",
        pendingApprovals: [],
        pendingFileEditApprovals: [fileEdit],
        messages: [],
      }),
    ).toEqual({ kind: "composer", approvalId: "file-1" });
  });

  it("lands on the inline plan card when the approval is not in the composer queue", () => {
    const messages = [
      messageWithSegments("m-1", [
        {
          id: "plan-block",
          kind: "plan",
          planId: "p1",
          planStatus: "awaiting_approval",
          harnessId: "claude",
          source: {
            harnessId: "claude",
            sessionId: "s1",
            turnId: "t1",
            kind: "approval-plan",
          },
          title: "Plan",
          summary: null,
          markdownPreview: "",
          fullContentRef: null,
          steps: [],
          actions: [],
          approvalId: "approval-plan",
          supersededByPlanId: null,
          isStreaming: false,
          contentIdentity: "id",
        },
      ]),
    ];
    expect(
      resolveApprovalJumpLanding({
        approvalId: "approval-plan",
        pendingApprovals: [
          {
            approvalId: "approval-plan",
            toolName: "plan",
            description: "implement",
            input: null,
            requestedAt: 1,
            kind: "plan",
            planId: "p1",
            actions: [],
          },
        ],
        pendingFileEditApprovals: [],
        messages,
      }),
    ).toEqual({ kind: "plan", blockId: "plan-block" });
  });

  it("holds when the approval is not in the composer queue and no plan card exists", () => {
    expect(
      resolveApprovalJumpLanding({
        approvalId: "missing",
        pendingApprovals: [toolApproval],
        pendingFileEditApprovals: [],
        messages: [],
      }),
    ).toEqual({ kind: "hold" });
  });
});

describe("landingBlockIdForJumpTarget: sent-message", () => {
  it("resolves the send tool's block id from receiver and verbatim text", () => {
    const messages = [
      messageWithSegments("m-1", [
        toolSegment({
          id: "send-block",
          agentMessageReceipt: null,
          agentMessageSend: {
            receiverAgentId: "receiver-1",
            message: "hello there",
          },
        }),
      ]),
    ];

    expect(
      landingBlockIdForJumpTarget(messages, {
        kind: "sent-message",
        receiverAgentId: "receiver-1",
        messageText: "hello there",
        timestamp: 0,
      }),
    ).toBe("send-block");
  });
});

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
      pendingInterviewBlockId: null,
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
      pendingInterviewBlockId: null,
    });

    expect(locator).toBeNull();
  });

  it("asks for nothing on the legacy line, which holds the whole transcript", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "receipt", messageId: "m-received" },
      transcriptWindow: null,
      messages: [],
      pendingInterviewBlockId: null,
    });

    expect(locator).toBeNull();
  });
});

describe("an `approval` jump target", () => {
  it("does not ask the host when the approval is already in the composer queue", () => {
    expect(
      hostLocatorForJumpTarget({
        target: { kind: "approval", approvalId: "tool-1" },
        transcriptWindow: windowNaming(["m-1"]),
        messages: [],
        pendingInterviewBlockId: null,
        pendingApprovals: [
          {
            approvalId: "tool-1",
            toolName: "Bash",
            description: "run",
            input: null,
            requestedAt: 1,
            kind: "tool",
            planId: null,
            actions: [],
          },
        ],
      }),
    ).toBeNull();
  });

  it("does not ask the host when the inline plan card is already rendered", () => {
    const messages = [
      messageWithSegments("m-1", [
        {
          id: "plan-block",
          kind: "plan",
          planId: "p1",
          planStatus: "awaiting_approval",
          harnessId: "claude",
          source: {
            harnessId: "claude",
            sessionId: "s1",
            turnId: "t1",
            kind: "approval-plan",
          },
          title: "Plan",
          summary: null,
          markdownPreview: "",
          fullContentRef: null,
          steps: [],
          actions: [],
          approvalId: "approval-plan",
          supersededByPlanId: null,
          isStreaming: false,
          contentIdentity: "id",
        },
      ]),
    ];
    expect(
      hostLocatorForJumpTarget({
        target: { kind: "approval", approvalId: "approval-plan" },
        transcriptWindow: windowNaming(["m-1"]),
        messages,
        pendingInterviewBlockId: null,
      }),
    ).toBeNull();
  });

  it("asks the host to locate a cold inline plan approval", () => {
    expect(
      hostLocatorForJumpTarget({
        target: { kind: "approval", approvalId: "approval-plan" },
        transcriptWindow: windowNaming(["m-1"]),
        messages: [],
        pendingInterviewBlockId: null,
      }),
    ).toEqual({ kind: "approval", approvalId: "approval-plan" });
  });

  it("uses the host's ordinal for a cold plan card", () => {
    expect(
      coldJumpOrdinal(
        windowNaming(["m-1"]),
        { kind: "approval", approvalId: "a-1" },
        4,
      ),
    ).toBe(4);
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
      pendingInterviewBlockId: null,
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
      pendingInterviewBlockId: null,
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
      pendingInterviewBlockId: null,
    });

    expect(locator).toBeNull();
  });

  it("asks for nothing on the legacy line, which holds the whole transcript", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: null,
      messages: [],
      pendingInterviewBlockId: null,
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
