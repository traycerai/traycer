import { describe, it, expect } from "vitest";
import {
  accumulateEvent,
  accumulateTurnContent,
  createTurnContentState,
} from "../agent-runtime-accumulator";
import {
  toolCallCompletedEventSchema,
  toolCallErroredEventSchema,
  toolCallStartedEventSchema,
} from "../agent-runtime";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";

function makeBlocks(): ContentBlock[] {
  return [];
}

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type ReasoningBlock = Extract<ContentBlock, { type: "reasoning" }>;
type ToolCallBlock = Extract<ContentBlock, { type: "tool_call" }>;
type FileChangeBlock = Extract<ContentBlock, { type: "file_change" }>;
type CommandBlock = Extract<ContentBlock, { type: "command" }>;
type SubAgentBlock = Extract<ContentBlock, { type: "subagent" }>;
type ApprovalBlock = Extract<ContentBlock, { type: "approval" }>;
type TodoBlock = Extract<ContentBlock, { type: "todo" }>;
type PlanBlock = Extract<ContentBlock, { type: "plan" }>;
type ErrorBlock = Extract<ContentBlock, { type: "error" }>;
type CompactionBlock = Extract<ContentBlock, { type: "compaction" }>;
type InterviewBlock = Extract<ContentBlock, { type: "interview" }>;

function expectPlanBlock(block: ContentBlock | undefined): PlanBlock {
  if (block?.type !== "plan") {
    throw new Error("Expected a plan block");
  }
  return block;
}

describe("accumulateEvent", () => {
  // ── text deltas ──────────────────────────────────────────────

  it("accumulates text deltas into a single TextBlock with concatenated text", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Hello",
    });
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 2,
      delta: " world",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as TextBlock).text).toBe("Hello world");
  });

  it("marks a text block completed without waiting for turn completion", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Hello",
    });
    blocks = accumulateEvent(blocks, {
      type: "text.completed",
      blockId: "t1",
      timestamp: 2,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].status).toBe("completed");
    expect(blocks[0].timestamp).toBe(2);
  });

  // ── reasoning deltas ─────────────────────────────────────────

  it("accumulates reasoning deltas into a single ReasoningBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 1,
      delta: "Think",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 2,
      delta: "ing...",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("reasoning");
    expect((blocks[0] as ReasoningBlock).content).toBe("Thinking...");
  });

  it("marks a reasoning block completed without waiting for turn completion", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 1,
      delta: "Thinking",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.completed",
      blockId: "r1",
      timestamp: 2,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("reasoning");
    expect(blocks[0].status).toBe("completed");
    expect(blocks[0].timestamp).toBe(2);
  });

  it("captures an immutable reasoning startedAt across deltas and completion", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 5,
      delta: "Think",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 9,
      delta: "ing",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.completed",
      blockId: "r1",
      timestamp: 12,
    });

    // `startedAt` stays the first-delta time while `timestamp` advances to the
    // completion time, so the GUI derives a stable 7ms (12 - 5) duration.
    expect((blocks[0] as ReasoningBlock).startedAt).toBe(5);
    expect(blocks[0].timestamp).toBe(12);
  });

  // ── tool call lifecycle ──────────────────────────────────────

  it("defaults omitted runtime tool-call agent message metadata to null", () => {
    expect(
      toolCallStartedEventSchema.parse({
        type: "tool_call.started",
        blockId: "tc1",
        timestamp: 1,
        toolName: "read_file",
      }).agentMessageSend,
    ).toBeNull();

    expect(
      toolCallCompletedEventSchema.parse({
        type: "tool_call.completed",
        blockId: "tc1",
        timestamp: 2,
        toolName: "read_file",
      }).agentMessageSend,
    ).toBeNull();

    expect(
      toolCallErroredEventSchema.parse({
        type: "tool_call.errored",
        blockId: "tc1",
        timestamp: 3,
        toolName: "read_file",
        error: "failed",
      }).agentMessageSend,
    ).toBeNull();
  });

  it("tool_call.started creates ToolCallBlock with streaming status", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 1,
      toolName: "read_file",
      input: { path: "/foo" },
      agentMessageSend: null,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_call");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as ToolCallBlock).toolName).toBe("read_file");
    // Raw input is no longer persisted; the block carries precomputed display.
    expect((blocks[0] as ToolCallBlock).inputSummary).toBe("/foo");
    expect((blocks[0] as ToolCallBlock).inputDetail).toEqual({
      kind: "fields",
      entries: [{ key: "path", label: "Path", value: "/foo" }],
    });
  });

  it("tool_call.started updates an existing ToolCallBlock instead of duplicating it", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 1,
      toolName: "TaskUpdate",
      input: {},
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 2,
      toolName: "TaskUpdate",
      input: { taskId: "1", status: "completed" },
      agentMessageSend: null,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_call");
    expect(blocks[0].status).toBe("streaming");
    expect(blocks[0].timestamp).toBe(2);
    // The update recomputes structured fields from the latest input. TaskUpdate
    // is a task-todo tool, so its item is parsed for the pinned-todo stack.
    expect((blocks[0] as ToolCallBlock).taskTodoItems).toEqual([
      {
        id: "1",
        text: null,
        status: "completed",
        priority: null,
        activeForm: null,
        action: "update",
      },
    ]);
  });

  it("tool_call.completed updates to completed with output", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 1,
      toolName: "read_file",
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.completed",
      blockId: "tc1",
      timestamp: 2,
      toolName: "read_file",
      agentMessageSend: null,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    // Tool output is intentionally not persisted (chat-doc bloat); the block
    // keeps the input-derived identity for the card.
    expect((blocks[0] as ToolCallBlock).toolName).toBe("read_file");
  });

  it("tool_call.errored updates to errored with error", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 1,
      toolName: "read_file",
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.errored",
      blockId: "tc1",
      timestamp: 2,
      toolName: "read_file",
      error: "File not found",
      agentMessageSend: null,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("errored");
    expect((blocks[0] as ToolCallBlock).error).toBe("File not found");
  });

  it("tool_call.progress replaces progress without advancing timestamp", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 1,
      toolName: "fetch",
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.progress",
      blockId: "tc1",
      timestamp: 5,
      update: "Fetched 1/10",
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.progress",
      blockId: "tc1",
      timestamp: 9,
      update: "Fetched 7/10",
    });

    expect(blocks).toHaveLength(1);
    const block = blocks[0] as ToolCallBlock;
    // replace-latest, not an append-log
    expect(block.progress).toBe("Fetched 7/10");
    expect(block.status).toBe("streaming");
    // timestamp stays anchored to the tool's start so the GUI elapsed heartbeat
    // (now − timestamp) keeps counting from when the tool began.
    expect(block.timestamp).toBe(1);
  });

  it("tool_call.progress for an unknown blockId is a no-op", () => {
    const blocks = makeBlocks();
    const next = accumulateEvent(blocks, {
      type: "tool_call.progress",
      blockId: "missing",
      timestamp: 5,
      update: "ignored",
    });

    expect(next).toBe(blocks);
    expect(next).toHaveLength(0);
  });

  // ── interleaved block types ──────────────────────────────────

  it("multiple interleaved block types produce correctly ordered blocks", () => {
    let blocks = makeBlocks();

    // text delta
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Let me read that file.",
    });

    // tool call
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 2,
      toolName: "read_file",
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.completed",
      blockId: "tc1",
      timestamp: 3,
      toolName: "read_file",
      agentMessageSend: null,
    });

    // another text delta with new blockId
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t2",
      timestamp: 4,
      delta: "Here is the result.",
    });

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("tool_call");
    expect(blocks[2].type).toBe("text");
  });

  // ── lifecycle events are ignored ─────────────────────────────

  it("session.created is ignored by accumulator", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "session.created",
      blockId: "s1",
      timestamp: 1,
      session: { id: "sess-123", harnessId: "claude", createdAt: 1 },
    });
    expect(blocks).toHaveLength(0);
  });

  it("session.resumed is ignored by accumulator", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "session.resumed",
      blockId: "s1",
      timestamp: 1,
      session: { id: "sess-123", harnessId: "claude", createdAt: 1 },
    });
    expect(blocks).toHaveLength(0);
  });

  it("turn.started is ignored by accumulator", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "turn.started",
      blockId: "turn1",
      timestamp: 1,
      turnId: "turn-123",
    });
    expect(blocks).toHaveLength(0);
  });

  it("turn.completed finalizes open text blocks", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Hello",
    });
    blocks = accumulateEvent(blocks, {
      type: "turn.completed",
      blockId: "turn1",
      timestamp: 2,
      turnId: "turn-123",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as TextBlock).text).toBe("Hello");
  });

  it("turn.completed finalizes open reasoning blocks", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 1,
      delta: "Thinking...",
    });
    blocks = accumulateEvent(blocks, {
      type: "turn.completed",
      blockId: "turn1",
      timestamp: 2,
      turnId: "turn-123",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("reasoning");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as ReasoningBlock).content).toBe("Thinking...");
  });

  it("turn.completed finalizes open content blocks but leaves a pending approval streaming", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Open text",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 2,
      delta: "Open reasoning",
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc1",
      timestamp: 3,
      toolName: "read_file",
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.completed",
      blockId: "tc1",
      timestamp: 4,
      toolName: "read_file",
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "approval.requested",
      blockId: "a1",
      timestamp: 5,
      toolName: "write_file",
      description: "Write to /foo",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 6,
      name: "explorer",
    });
    blocks = accumulateEvent(blocks, {
      type: "turn.completed",
      blockId: "turn1",
      timestamp: 7,
      turnId: "turn-123",
    });

    expect(blocks).toHaveLength(5);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].status).toBe("completed");
    expect(blocks[1].type).toBe("reasoning");
    expect(blocks[1].status).toBe("completed");
    expect(blocks[2].type).toBe("tool_call");
    expect(blocks[2].status).toBe("completed");
    expect((blocks[2] as ToolCallBlock).toolName).toBe("read_file");
    expect(blocks[3].type).toBe("approval");
    // approval is resolved out-of-band (user decision / abandon-cleanup), so the
    // turn boundary must NOT force-complete it.
    expect(blocks[3].status).toBe("streaming");
    expect(blocks[4].type).toBe("subagent");
    expect(blocks.find((block) => block.blockId === "sa1")?.status).toBe(
      "completed",
    );
  });

  it("turn.completed leaves a pending interview streaming (resolved out-of-band)", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "interview.requested",
      blockId: "iv1",
      timestamp: 1,
      toolName: "AskUserQuestion",
      title: "Question",
      questions: [],
      input: {},
    });
    blocks = accumulateEvent(blocks, {
      type: "turn.completed",
      blockId: "turn1",
      timestamp: 2,
      turnId: "turn-123",
    });
    const interview = blocks.find((block) => block.blockId === "iv1");
    expect(interview?.type).toBe("interview");
    // Force-completing it here would flash "completed, 0 answered" before the
    // host's interview.errored cleanup lands.
    expect(interview?.status).toBe("streaming");
  });

  // ── error events ─────────────────────────────────────────────

  it("error events create ErrorBlock without corrupting existing blocks", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "Hello",
    });
    blocks = accumulateEvent(blocks, {
      type: "error",
      blockId: "err1",
      timestamp: 2,
      message: "something went wrong",
      recoverable: false,
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as TextBlock).text).toBe("Hello");
    expect(blocks[1].type).toBe("error");
    expect(blocks[1].status).toBe("errored");
    expect((blocks[1] as ErrorBlock).message).toBe("something went wrong");
    expect((blocks[1] as ErrorBlock).recoverable).toBe(false);
  });

  // ── approval events ──────────────────────────────────────────

  it("approval.requested creates ApprovalBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "approval.requested",
      blockId: "a1",
      timestamp: 1,
      toolName: "write_file",
      description: "Write to /foo",
      input: { path: "/foo" },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("approval");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as ApprovalBlock).toolName).toBe("write_file");
    expect((blocks[0] as ApprovalBlock).description).toBe("Write to /foo");
  });

  it("approval.resolved updates ApprovalBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "approval.requested",
      blockId: "a1",
      timestamp: 1,
      toolName: "write_file",
      description: "Write to /foo",
    });
    blocks = accumulateEvent(blocks, {
      type: "approval.resolved",
      blockId: "a1",
      timestamp: 2,
      decision: { approved: true, reason: "Looks good" },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as ApprovalBlock).decision).toEqual({
      approved: true,
      reason: "Looks good",
    });
  });

  it("approval.resolved without approval.requested creates a completed ApprovalBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "approval.resolved",
      blockId: "a1",
      timestamp: 1,
      decision: { approved: false, reason: "Denied" },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("approval");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as ApprovalBlock).toolName).toBeNull();
    expect((blocks[0] as ApprovalBlock).description).toBeNull();
    expect((blocks[0] as ApprovalBlock).decision).toEqual({
      approved: false,
      reason: "Denied",
    });
  });

  it("approval deny pair (requested→resolved) yields one denied block carrying toolName", () => {
    // The interactive approval flow (canUseTool → user/policy deny) emits a
    // requested+resolved pair on the same blockId so the card renders
    // "Denied <tool>: <reason>" rather than a tool-less sparse card. (Auto-denies
    // surfaced only in the turn-final result take the separate `tool_call.errored`
    // path on the attempted tool's own block - see claude-converter.)
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "approval.requested",
      blockId: "deny-1",
      timestamp: 1,
      toolName: "Bash",
      description: "Command blocked by policy",
    });
    blocks = accumulateEvent(blocks, {
      type: "approval.resolved",
      blockId: "deny-1",
      timestamp: 2,
      decision: { approved: false, reason: "Auto-denied by permission rules" },
    });

    expect(blocks).toHaveLength(1);
    const block = blocks[0] as ApprovalBlock;
    expect(block.type).toBe("approval");
    expect(block.status).toBe("completed");
    expect(block.toolName).toBe("Bash");
    expect(block.description).toBe("Command blocked by policy");
    expect(block.decision).toEqual({
      approved: false,
      reason: "Auto-denied by permission rules",
    });
  });

  // ── todo events ──────────────────────────────────────────────

  it("todo.updated creates and updates TodoBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "todo.updated",
      blockId: "todo1",
      timestamp: 1,
      items: [{ text: "Write tests", status: "pending" }],
    });
    blocks = accumulateEvent(blocks, {
      type: "todo.updated",
      blockId: "todo1",
      timestamp: 2,
      items: [{ text: "Write tests", status: "completed" }],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("todo");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as TodoBlock).items).toEqual([
      {
        id: null,
        text: "Write tests",
        status: "completed",
        priority: null,
        activeForm: null,
      },
    ]);
  });

  // ── plan events ──────────────────────────────────────────────

  it("plan.delta creates a drafting PlanBlock and appends later deltas", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.delta",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      delta: "1. Inspect protocol\n",
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.delta",
      blockId: "plan-block-1",
      timestamp: 2,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      delta: "2. Add schemas\n",
    });

    expect(blocks).toHaveLength(1);
    const block = expectPlanBlock(blocks[0]);
    expect(block.status).toBe("streaming");
    expect(block.planStatus).toBe("drafting");
    expect(block.markdownPreview).toBe("1. Inspect protocol\n2. Add schemas\n");
  });

  it("turn.completed promotes a still-drafting plan to ready (never stuck drafting)", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.delta",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      delta: "1. Inspect protocol\n",
    });
    // A plan left streaming when the turn ends never received an explicit
    // plan.completed. The finalizer must flip it to completed AND advance
    // planStatus out of "drafting" so the card stops showing a "Drafting"
    // spinner forever.
    blocks = accumulateEvent(blocks, {
      type: "turn.completed",
      blockId: "turn-1",
      timestamp: 99,
      turnId: "turn-1",
    });

    const block = expectPlanBlock(blocks[0]);
    expect(block.status).toBe("completed");
    expect(block.planStatus).toBe("ready");
    expect(block.markdownPreview).toBe("1. Inspect protocol\n");
  });

  it("plan.updated reuses an existing block by planId and replaces the structured snapshot", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.delta",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      delta: "draft",
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-reemitted",
      timestamp: 2,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "awaiting_approval",
      title: "Protocol plan",
      summary: "Add plan protocol support.",
      markdownPreview: "## Plan\n- Add schemas",
      fullContentRef: { kind: "plan_content", hash: "hash-1" },
      steps: [
        {
          id: "step-1",
          text: "Add schemas",
          status: "completed",
          activeForm: null,
        },
      ],
      actions: [
        {
          id: "implement",
          label: "Implement",
          decision: "approve",
          variant: "primary",
        },
      ],
      approvalId: "approval-1",
      supersededByPlanId: null,
      metadata: { providerEvent: "turn/plan/updated" },
    });

    expect(blocks).toHaveLength(1);
    const block = expectPlanBlock(blocks[0]);
    expect(block.blockId).toBe("plan-block-1");
    expect(block.status).toBe("completed");
    expect(block.planStatus).toBe("awaiting_approval");
    expect(block.title).toBe("Protocol plan");
    expect(block.markdownPreview).toBe("## Plan\n- Add schemas");
    expect(block.steps).toEqual([
      {
        id: "step-1",
        text: "Add schemas",
        status: "completed",
        activeForm: null,
      },
    ]);
    expect(block.approvalId).toBe("approval-1");
  });

  it("plan.completed finalizes a drafting plan without replacing its preview", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.delta",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      delta: "draft plan",
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.completed",
      blockId: "plan-block-1",
      timestamp: 2,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      markdownPreview: null,
      fullContentRef: null,
      actions: [],
      approvalId: null,
    });

    const block = expectPlanBlock(blocks[0]);
    expect(block.status).toBe("completed");
    expect(block.planStatus).toBe("ready");
    expect(block.markdownPreview).toBe("draft plan");
  });

  it("plan.completed reuses an existing plan block by planId when provider block ids drift", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.delta",
      blockId: "plan-block-original",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      delta: "draft plan",
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.completed",
      blockId: "plan-block-reemitted",
      timestamp: 2,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      markdownPreview: "completed plan",
      fullContentRef: null,
      actions: [],
      approvalId: null,
    });

    expect(blocks).toHaveLength(1);
    const block = expectPlanBlock(blocks[0]);
    expect(block.blockId).toBe("plan-block-original");
    expect(block.planId).toBe("plan-1");
    expect(block.planStatus).toBe("ready");
    expect(block.markdownPreview).toBe("completed plan");
  });

  it("keeps generic todo updates as todo blocks after a completed plan", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.completed",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      markdownPreview: "completed plan",
      fullContentRef: null,
      actions: [],
      approvalId: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "todo.updated",
      blockId: "todo-generic",
      timestamp: 2,
      items: [
        {
          id: "todo-1",
          text: "Generic task outside explicit plan folding",
          status: "pending",
        },
      ],
    });

    expect(blocks.map((block) => block.type)).toEqual(["plan", "todo"]);
    expectPlanBlock(blocks[0]);
    const todo = blocks[1];
    if (todo?.type !== "todo") throw new Error("Expected todo block");
    expect(todo.items[0]).toMatchObject({
      id: "todo-1",
      text: "Generic task outside explicit plan folding",
    });
  });

  it("approval.resolved updates a matching plan block by approvalId", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "claude",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "approval-plan",
      },
      planStatus: "awaiting_approval",
      title: "Claude plan",
      summary: null,
      markdownPreview: "Plan body",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: "approval-1",
      supersededByPlanId: null,
      metadata: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "approval.resolved",
      blockId: "approval-1",
      timestamp: 2,
      decision: { approved: true, reason: "Implement it" },
    });

    expect(blocks).toHaveLength(2);
    const block = expectPlanBlock(blocks[0]);
    expect(block.status).toBe("completed");
    expect(block.planStatus).toBe("approved");
    expect(block.timestamp).toBe(2);
  });

  it("plan.updated applies an already-emitted approval.resolved event", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "approval.resolved",
      blockId: "approval-1",
      timestamp: 1,
      decision: { approved: false, reason: "Not yet" },
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-1",
      timestamp: 2,
      planId: "plan-1",
      source: {
        harnessId: "claude",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "approval-plan",
      },
      planStatus: "awaiting_approval",
      title: "Claude plan",
      summary: null,
      markdownPreview: "Plan body",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: "approval-1",
      supersededByPlanId: null,
      metadata: null,
    });

    expect(blocks).toHaveLength(2);
    const block = expectPlanBlock(blocks[1]);
    expect(block.planStatus).toBe("rejected");
    expect(block.status).toBe("completed");
  });

  it("a new completed peer plan supersedes an older active plan in the same turn", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      title: "First plan",
      summary: null,
      markdownPreview: "First",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-2",
      timestamp: 2,
      planId: "plan-2",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      title: "Second plan",
      summary: null,
      markdownPreview: "Second",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });

    expect(blocks).toHaveLength(2);
    const first = expectPlanBlock(blocks[0]);
    const second = expectPlanBlock(blocks[1]);
    expect(first.planStatus).toBe("superseded");
    expect(first.supersededByPlanId).toBe("plan-2");
    expect(first.timestamp).toBe(2);
    expect(second.planStatus).toBe("ready");
  });

  it("a new completed peer plan supersedes an older active plan in the same session with a different turn", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "awaiting_approval",
      title: "First plan",
      summary: null,
      markdownPreview: "First",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: "approval-1",
      supersededByPlanId: null,
      metadata: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-2",
      timestamp: 2,
      planId: "plan-2",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-2",
        kind: "provider-plan",
      },
      planStatus: "ready",
      title: "Second plan",
      summary: null,
      markdownPreview: "Second",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });

    expect(blocks).toHaveLength(2);
    const first = expectPlanBlock(blocks[0]);
    const second = expectPlanBlock(blocks[1]);
    expect(first.planStatus).toBe("superseded");
    expect(first.supersededByPlanId).toBe("plan-2");
    expect(second.planStatus).toBe("ready");
  });

  it("does not supersede plans from different sessions or incompatible source kinds", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-1",
      timestamp: 1,
      planId: "plan-1",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      title: "First plan",
      summary: null,
      markdownPreview: "First",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-2",
      timestamp: 2,
      planId: "plan-2",
      source: {
        harnessId: "codex",
        sessionId: "session-2",
        turnId: "turn-2",
        kind: "provider-plan",
      },
      planStatus: "ready",
      title: "Second plan",
      summary: null,
      markdownPreview: "Second",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });

    expect(expectPlanBlock(blocks[0]).planStatus).toBe("ready");
    expect(expectPlanBlock(blocks[1]).planStatus).toBe("ready");

    blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-3",
      timestamp: 3,
      planId: "plan-3",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-3",
        kind: "provider-plan",
      },
      planStatus: "ready",
      title: "Third plan",
      summary: null,
      markdownPreview: "Third",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "plan.updated",
      blockId: "plan-block-4",
      timestamp: 4,
      planId: "plan-4",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-4",
        kind: "approval-plan",
      },
      planStatus: "ready",
      title: "Fourth plan",
      summary: null,
      markdownPreview: "Fourth",
      fullContentRef: null,
      steps: [],
      actions: [],
      approvalId: null,
      supersededByPlanId: null,
      metadata: null,
    });

    expect(expectPlanBlock(blocks[0]).planStatus).toBe("ready");
    expect(expectPlanBlock(blocks[1]).planStatus).toBe("ready");
  });

  // ── compaction events ────────────────────────────────────────

  it("compaction events create and complete CompactionBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "compaction.started",
      blockId: "compact1",
      timestamp: 1,
      trigger: "auto",
      preTokens: 1000,
    });
    blocks = accumulateEvent(blocks, {
      type: "compaction.completed",
      blockId: "compact1",
      timestamp: 2,
      postTokens: 400,
      durationMs: 50,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("compaction");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as CompactionBlock).trigger).toBe("auto");
    expect((blocks[0] as CompactionBlock).preTokens).toBe(1000);
    expect((blocks[0] as CompactionBlock).postTokens).toBe(400);
  });

  // ── interview events ─────────────────────────────────────────

  it("interview events create and complete InterviewBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "interview.requested",
      blockId: "interview1",
      timestamp: 1,
      toolName: "AskUserQuestion",
      title: "Question",
      questions: [
        {
          questionId: null,
          question: "Which library?",
          header: "Library",
          options: [{ label: "date-fns", description: "Small", preview: null }],
          multiSelect: false,
        },
      ],
    });
    blocks = accumulateEvent(blocks, {
      type: "interview.resolved",
      blockId: "interview1",
      timestamp: 2,
      answers: [
        {
          questionId: null,
          question: "Which library?",
          values: ["date-fns"],
          notes: null,
        },
      ],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("interview");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as InterviewBlock).toolName).toBe("AskUserQuestion");
    expect((blocks[0] as InterviewBlock).answers).toEqual([
      {
        questionId: null,
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
      },
    ]);
  });

  it("a later empty interview.resolved does not erase recorded answers", () => {
    // The OpenCode adapter resolves the card with the user's real answers, then
    // the converter emits a SECOND interview.resolved whose answers are empty
    // (OpenCode's question tool output is an unparseable English sentence). The
    // empty resolution must not regress the card to "No answer".
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "interview.requested",
      blockId: "interview1",
      timestamp: 1,
      toolName: "question",
      title: "question",
      questions: [
        {
          questionId: null,
          question: "Where should the game live?",
          header: "Location",
          options: [{ label: "gui-app", description: null, preview: null }],
          multiSelect: false,
        },
      ],
    });
    blocks = accumulateEvent(blocks, {
      type: "interview.resolved",
      blockId: "interview1",
      timestamp: 2,
      answers: [
        {
          questionId: null,
          question: "Where should the game live?",
          values: ["gui-app"],
          notes: null,
        },
      ],
    });
    blocks = accumulateEvent(blocks, {
      type: "interview.resolved",
      blockId: "interview1",
      timestamp: 3,
      answers: [],
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as InterviewBlock).answers).toEqual([
      {
        questionId: null,
        question: "Where should the game live?",
        values: ["gui-app"],
        notes: null,
      },
    ]);
  });

  it("interview.requested updates an existing empty InterviewBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "interview.requested",
      blockId: "interview1",
      timestamp: 1,
      toolName: "AskUserQuestion",
      title: "AskUserQuestion",
      questions: [],
      input: {},
    });
    blocks = accumulateEvent(blocks, {
      type: "interview.requested",
      blockId: "interview1",
      timestamp: 2,
      toolName: "AskUserQuestion",
      title: "AskUserQuestion",
      questions: [
        {
          questionId: null,
          question: "Proceed with the P1 fixes?",
          header: "Approval",
          options: [
            { label: "Yes", description: "Apply fixes", preview: null },
          ],
          multiSelect: false,
        },
      ],
      input: {
        questions: [{ question: "Proceed with the P1 fixes?" }],
      },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("interview");
    expect((blocks[0] as InterviewBlock).questions).toEqual([
      {
        questionId: null,
        question: "Proceed with the P1 fixes?",
        header: "Approval",
        options: [{ label: "Yes", description: "Apply fixes", preview: null }],
        multiSelect: false,
      },
    ]);
    // Interview blocks no longer persist raw input; the questions/answers above
    // are the rendered surface.
  });

  // ── file change events ───────────────────────────────────────

  it("file_change.started creates FileChangeBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "file_change.started",
      blockId: "fc1",
      timestamp: 1,
      filePath: "/src/index.ts",
      operation: "edit",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("file_change");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as FileChangeBlock).filePath).toBe("/src/index.ts");
    expect((blocks[0] as FileChangeBlock).diffSource).toBe("none");
  });

  it("file_change.completed updates FileChangeBlock with snapshot content", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "file_change.started",
      blockId: "fc1",
      timestamp: 1,
      filePath: "/src/index.ts",
      operation: "edit",
    });
    blocks = accumulateEvent(blocks, {
      type: "file_change.completed",
      blockId: "fc1",
      timestamp: 2,
      filePath: "/src/index.ts",
      operation: "edit",
      diffSource: "snapshot",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      additions: 1,
      deletions: 1,
      reason: "snapshot",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    const block = blocks[0] as FileChangeBlock;
    expect(block.diffSource).toBe("snapshot");
    expect(block.beforeHash).toBe("a".repeat(64));
    expect(block.afterHash).toBe("b".repeat(64));
    expect(block.additions).toBe(1);
    expect(block.deletions).toBe(1);
    expect(block.reason).toBe("snapshot");
  });

  it("honors explicit null parentBlockId updates as top-level", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "file_change.started",
      blockId: "fc1",
      timestamp: 1,
      parentBlockId: "subagent-1",
      filePath: "/src/index.ts",
      operation: "edit",
    });
    blocks = accumulateEvent(blocks, {
      type: "file_change.completed",
      blockId: "fc1",
      timestamp: 2,
      parentBlockId: null,
      filePath: "/src/index.ts",
      operation: "edit",
      diffSource: "snapshot",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      additions: 1,
      deletions: 1,
      reason: "snapshot",
    });

    expect(blocks[0]).toMatchObject({ parentBlockId: null });
  });

  it("file_change.completed with reason='binary' lands as a none-diff block", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "file_change.completed",
      blockId: "fc3",
      timestamp: 2,
      filePath: "/assets/logo.png",
      operation: "edit",
      diffSource: "none",
      beforeHash: null,
      afterHash: null,
      additions: 0,
      deletions: 0,
      reason: "binary",
    });

    const block = blocks[0] as FileChangeBlock;
    expect(block.diffSource).toBe("none");
    expect(block.beforeHash).toBeNull();
    expect(block.afterHash).toBeNull();
    expect(block.reason).toBe("binary");
  });

  // ── command events ───────────────────────────────────────────

  it("command.started creates CommandBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "command.started",
      blockId: "cmd1",
      timestamp: 1,
      command: "npm test",
      cwd: "/workspace",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("command");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as CommandBlock).command).toBe("npm test");
    expect((blocks[0] as CommandBlock).cwd).toBe("/workspace");
  });

  it("command.completed updates CommandBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "command.started",
      blockId: "cmd1",
      timestamp: 1,
      command: "npm test",
      cwd: "/workspace",
    });
    blocks = accumulateEvent(blocks, {
      type: "command.completed",
      blockId: "cmd1",
      timestamp: 2,
      command: "npm test",
      exitCode: 0,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as CommandBlock).exitCode).toBe(0);
  });

  // ── sub-agent events ─────────────────────────────────────────

  it("subagent.started creates SubAgentBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 1,
      name: "explorer",
      task: "Find the file",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("subagent");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as SubAgentBlock).name).toBe("explorer");
    expect((blocks[0] as SubAgentBlock).progressUpdates).toEqual([]);
    expect((blocks[0] as SubAgentBlock).startedAt).toBe(1);
    expect((blocks[0] as SubAgentBlock).spawnToolCallId).toBeNull();
  });

  it("keeps an immutable startedAt and the spawn tool id across progress/completion", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 5,
      name: "explorer",
      task: "Investigate",
      spawnToolCallId: "toolu_42",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.progress",
      blockId: "sa1",
      timestamp: 9,
      update: "working",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.completed",
      blockId: "sa1",
      timestamp: 12,
      result: "done",
    });

    const block = blocks[0] as SubAgentBlock;
    // startedAt stays the spawn time while timestamp advances to completion.
    expect(block.startedAt).toBe(5);
    expect(block.timestamp).toBe(12);
    // the spawn tool id survives progress/completion.
    expect(block.spawnToolCallId).toBe("toolu_42");
  });

  it("re-emitted subagent.started updates the open card's name in place (no duplicate)", () => {
    let blocks = makeBlocks();
    // Card opens with the placeholder name while the async name fetch is in
    // flight...
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 1,
      name: "Subagent",
      task: "Investigate the auth flow",
      spawnToolCallId: "toolu_9",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.progress",
      blockId: "sa1",
      timestamp: 2,
      update: "rg --files",
    });
    // ...then the fetched nickname re-emits subagent.started (carrying no spawn
    // tool id of its own).
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 3,
      name: "Godel (explorer)",
      task: "Investigate the auth flow",
    });

    expect(blocks).toHaveLength(1); // updated in place, not duplicated
    expect((blocks[0] as SubAgentBlock).name).toBe("Godel (explorer)");
    // existing progress is preserved across the name update
    expect((blocks[0] as SubAgentBlock).progressUpdates).toEqual([
      "rg --files",
    ]);
    expect(blocks[0].status).toBe("streaming");
    // startedAt is the immutable spawn time, preserved across the re-emit.
    expect((blocks[0] as SubAgentBlock).startedAt).toBe(1);
    // the spawn tool id from the first start survives a name-only re-emit.
    expect((blocks[0] as SubAgentBlock).spawnToolCallId).toBe("toolu_9");
  });

  it("subagent.progress appends to progressUpdates array", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 1,
      name: "explorer",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.progress",
      blockId: "sa1",
      timestamp: 2,
      update: "Searching...",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.progress",
      blockId: "sa1",
      timestamp: 3,
      update: "Found 3 files",
    });

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as SubAgentBlock).progressUpdates).toEqual([
      "Searching...",
      "Found 3 files",
    ]);
  });

  it("subagent.progress without subagent.started creates a streaming SubAgentBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.progress",
      blockId: "sa1",
      timestamp: 1,
      update: "Searching...",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("subagent");
    expect(blocks[0].status).toBe("streaming");
    expect((blocks[0] as SubAgentBlock).name).toBeNull();
    expect((blocks[0] as SubAgentBlock).progressUpdates).toEqual([
      "Searching...",
    ]);
  });

  it("subagent.completed finalizes SubAgentBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 1,
      name: "explorer",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.completed",
      blockId: "sa1",
      timestamp: 2,
      result: "Done exploring",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as SubAgentBlock).result).toBe("Done exploring");
  });

  it("subagent.completed without subagent.started creates a completed SubAgentBlock", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.completed",
      blockId: "sa1",
      timestamp: 1,
      result: "Done exploring",
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("subagent");
    expect(blocks[0].status).toBe("completed");
    expect((blocks[0] as SubAgentBlock).name).toBeNull();
    expect((blocks[0] as SubAgentBlock).progressUpdates).toEqual([]);
    expect((blocks[0] as SubAgentBlock).result).toBe("Done exploring");
    // No `started` was seen, so the spawn time is unknown: startedAt stays null
    // (not the completion time) so the card shows no misleading "0s" duration.
    expect((blocks[0] as SubAgentBlock).startedAt).toBeNull();
  });

  it("a post-completion subagent.started re-emit does not advance the completion timestamp", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 1000,
      name: "Subagent",
      task: "Investigate",
    });
    blocks = accumulateEvent(blocks, {
      type: "subagent.completed",
      blockId: "sa1",
      timestamp: 2000,
      result: "done",
    });
    // Codex resolves the nickname a beat later and re-emits subagent.started
    // (with Date.now()) AFTER the sub-agent already completed.
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 6000,
      name: "Godel (explorer)",
      task: "Investigate",
    });

    const block = blocks[0] as SubAgentBlock;
    // The name still updates in place...
    expect(block.name).toBe("Godel (explorer)");
    // ...but the completion timestamp stays at 2000, not the 6000 re-emit, so
    // the derived duration (timestamp - startedAt) is not inflated.
    expect(block.status).toBe("completed");
    expect(block.timestamp).toBe(2000);
    expect(block.startedAt).toBe(1000);
  });
});

describe("accumulateTurnContent", () => {
  it("increments blocksVersion only when a runtime event changes blocks", () => {
    let state = createTurnContentState();
    state = accumulateTurnContent(state, {
      type: "turn.started",
      blockId: "turn-1",
      turnId: "turn-1",
      timestamp: 1,
    });
    expect(state.blocksVersion).toBe(0);

    state = accumulateTurnContent(state, {
      type: "text.delta",
      blockId: "text-1",
      timestamp: 2,
      delta: "Hello",
    });
    expect(state.blocksVersion).toBe(1);

    state = accumulateTurnContent(state, {
      type: "text.completed",
      blockId: "text-1",
      timestamp: 3,
    });
    expect(state.blocksVersion).toBe(2);

    const unchanged = accumulateTurnContent(state, {
      type: "text.completed",
      blockId: "text-1",
      timestamp: 4,
    });
    expect(unchanged).toBe(state);
    expect(unchanged.blocksVersion).toBe(2);
  });
});

describe("turn-end finalization of streaming blocks", () => {
  function startedActionBlocks(): ContentBlock[] {
    let blocks: ContentBlock[] = [];
    blocks = accumulateEvent(blocks, {
      type: "subagent.started",
      blockId: "sa",
      timestamp: 1,
      name: "explorer",
      task: "investigate",
    });
    blocks = accumulateEvent(blocks, {
      type: "file_change.started",
      blockId: "fc",
      timestamp: 2,
      filePath: "/repo/a.ts",
      operation: "modify",
    });
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc",
      timestamp: 3,
      toolName: "read",
      input: {},
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "command.started",
      blockId: "cmd",
      timestamp: 4,
      command: "ls",
      cwd: "/",
    });
    return blocks;
  }

  it("marks every in-flight action block 'interrupted' on turn.stopped (sub-agent, file edit, tool, command)", () => {
    let blocks = startedActionBlocks();
    expect(blocks.every((b) => b.status === "streaming")).toBe(true);

    // The user hits Stop - in-flight actions are interrupted, not a misleading
    // green "completed", and not a red "errored".
    blocks = accumulateEvent(blocks, {
      type: "turn.stopped",
      blockId: "turn",
      timestamp: 5,
      turnId: "turn",
    });

    expect(blocks.map((b) => b.status)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
  });

  it("marks every in-flight action block 'superseded' on a steer-restart turn.interrupted", () => {
    let blocks = startedActionBlocks();

    // A queued steer interrupts and restarts the turn (code STEER_RESTART).
    blocks = accumulateEvent(blocks, {
      type: "turn.interrupted",
      blockId: "turn",
      timestamp: 5,
      turnId: "turn",
      reason: "Turn interrupted to run a queued steering request.",
      code: "STEER_RESTART",
      recoverable: true,
    });

    expect(blocks.map((b) => b.status)).toEqual([
      "superseded",
      "superseded",
      "superseded",
      "superseded",
    ]);
  });

  it("completes in-flight action blocks on a clean turn.completed", () => {
    let blocks = startedActionBlocks();
    blocks = accumulateEvent(blocks, {
      type: "turn.completed",
      blockId: "turn",
      timestamp: 5,
      turnId: "turn",
    });
    expect(blocks.map((b) => b.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("treats a non-steer turn.interrupted as 'interrupted'", () => {
    let blocks = startedActionBlocks();
    blocks = accumulateEvent(blocks, {
      type: "turn.interrupted",
      blockId: "turn",
      timestamp: 5,
      turnId: "turn",
      reason: "Provider stream failed.",
      recoverable: false,
    });
    expect(blocks.map((b) => b.status)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
  });

  it("always completes text/reasoning content on Stop (a partial thought is not interrupted)", () => {
    let blocks: ContentBlock[] = [];
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "tx",
      timestamp: 1,
      delta: "partial answer",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "rs",
      timestamp: 2,
      delta: "thinking",
    });
    blocks = accumulateEvent(blocks, {
      type: "turn.stopped",
      blockId: "turn",
      timestamp: 5,
      turnId: "turn",
    });
    const byId = (id: string) => blocks.find((b) => b.blockId === id)!;
    expect(byId("tx").status).toBe("completed");
    expect(byId("rs").status).toBe("completed");
  });

  it("preserves the start timestamp of interrupted tool_call/command (the GUI elapsed anchor) but advances reasoning's", () => {
    let blocks: ContentBlock[] = [];
    blocks = accumulateEvent(blocks, {
      type: "tool_call.started",
      blockId: "tc",
      timestamp: 10,
      toolName: "read",
      input: {},
      agentMessageSend: null,
    });
    blocks = accumulateEvent(blocks, {
      type: "command.started",
      blockId: "cmd",
      timestamp: 11,
      command: "ls",
      cwd: "/",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "rs",
      timestamp: 12,
      delta: "thinking",
    });

    blocks = accumulateEvent(blocks, {
      type: "turn.stopped",
      blockId: "turn",
      timestamp: 99,
      turnId: "turn",
    });

    const byId = (id: string) => blocks.find((b) => b.blockId === id)!;
    // tool_call / command: interrupted, and timestamp (the start anchor) preserved.
    expect(byId("tc").status).toBe("interrupted");
    expect(byId("tc").timestamp).toBe(10);
    expect(byId("cmd").status).toBe("interrupted");
    expect(byId("cmd").timestamp).toBe(11);
    // reasoning: completed (content, not a failed action) and timestamp (the
    // completion time, drives "Thought for Xs") advanced to the turn-end instant.
    expect(byId("rs").status).toBe("completed");
    expect(byId("rs").timestamp).toBe(99);
  });
});

describe("accumulateEvent - artifact_operation", () => {
  function expectArtifactOpBlock(
    block: ContentBlock | undefined,
  ): Extract<ContentBlock, { type: "artifact_operation" }> {
    if (block?.type !== "artifact_operation") {
      throw new Error("Expected an artifact_operation block");
    }
    return block;
  }

  it("appends a completed artifact_operation block keyed by blockId", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 5,
      operation: "create",
      kind: "spec",
      artifactId: "spec-1",
      title: "Spec Title",
    });

    expect(blocks).toHaveLength(1);
    const block = expectArtifactOpBlock(blocks[0]);
    expect(block.status).toBe("completed");
    expect(block.operation).toBe("create");
    expect(block.kind).toBe("spec");
    expect(block.artifactId).toBe("spec-1");
    expect(block.title).toBe("Spec Title");
    expect(block.timestamp).toBe(5);
  });

  it("upserts in place on a re-emit with the same blockId (no duplicate)", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 5,
      operation: "create",
      kind: "spec",
      artifactId: "spec-1",
    });
    // A late re-resolution replaces the earlier emit for the same action+index.
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 7,
      operation: "update",
      kind: "spec",
      artifactId: "spec-1",
    });

    expect(blocks).toHaveLength(1);
    const block = expectArtifactOpBlock(blocks[0]);
    expect(block.operation).toBe("update");
    expect(block.timestamp).toBe(7);
  });

  it("preserves existing artifact diff hashes when a re-emit omits them", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 5,
      operation: "update",
      kind: "spec",
      artifactId: "spec-1",
      beforeHash: "before",
      afterHash: "after",
    });
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 7,
      operation: "update",
      kind: "spec",
      artifactId: "spec-1",
    });
    expect(expectArtifactOpBlock(blocks[0]).beforeHash).toBe("before");
    expect(expectArtifactOpBlock(blocks[0]).afterHash).toBe("after");

    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 8,
      operation: "update",
      kind: "spec",
      artifactId: "spec-1",
      beforeHash: null,
      afterHash: null,
    });

    expect(blocks).toHaveLength(1);
    const block = expectArtifactOpBlock(blocks[0]);
    expect(block.beforeHash).toBeNull();
    expect(block.afterHash).toBeNull();
  });

  it("keeps distinct indexed blockIds as separate cards (cascade delete)", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "bash1:artifact-op:0",
      timestamp: 5,
      operation: "delete",
      kind: "ticket",
      artifactId: "ticket-1",
    });
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "bash1:artifact-op:1",
      timestamp: 5,
      operation: "delete",
      kind: "ticket",
      artifactId: "ticket-2",
    });

    expect(blocks).toHaveLength(2);
    expect(expectArtifactOpBlock(blocks[0]).artifactId).toBe("ticket-1");
    expect(expectArtifactOpBlock(blocks[1]).artifactId).toBe("ticket-2");
  });

  it("nests under a parent block when parentBlockId is set", () => {
    let blocks = makeBlocks();
    blocks = accumulateEvent(blocks, {
      type: "artifact_operation",
      blockId: "fc1:artifact-op:0",
      timestamp: 5,
      parentBlockId: "subagent-1",
      operation: "create",
      kind: "review",
      artifactId: "review-1",
    });

    expect(expectArtifactOpBlock(blocks[0]).parentBlockId).toBe("subagent-1");
  });
});
