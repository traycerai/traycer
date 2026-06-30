import { describe, expect, it } from "vitest";
import {
  contentBlockSchema,
  type ApprovalBlock,
  type FileChangeBlock,
  type InterviewBlock,
  type ToolCallBlock,
} from "@traycer/protocol/persistence/epic/content-blocks";

describe("fileChangeBlockSchema backward-compat", () => {
  it("parses a pre-compaction file_change block (no hashes/counts) via defaults", () => {
    // A block persisted before the payload-compaction change: it carries the
    // old inline beforeContent/afterContent (now unknown keys, stripped) and
    // lacks beforeHash/afterHash/additions/deletions. It must parse cleanly -
    // a hard ZodError here would break agent.getTranscript for the whole chat.
    const legacy = {
      type: "file_change",
      blockId: "blk-legacy",
      status: "completed",
      timestamp: 1,
      filePath: "/repo/src/app.ts",
      operation: "edit",
      diffSource: "snapshot",
      beforeContent: "old\n",
      afterContent: "new\n",
      reason: "snapshot",
    };

    const parsed = contentBlockSchema.parse(legacy);
    expect(parsed.type).toBe("file_change");
    const block = parsed as FileChangeBlock;
    expect(block.beforeHash).toBeNull();
    expect(block.afterHash).toBeNull();
    expect(block.additions).toBe(0);
    expect(block.deletions).toBe(0);
    // The dropped inline content is not retained.
    expect("beforeContent" in block).toBe(false);
  });

  it("parses a pre-refactor tool_call block (raw input, no summary/detail) via defaults", () => {
    // A block persisted before the structured-input refactor: it carries the
    // old inline `input` (now an unknown key, stripped) and lacks
    // inputSummary/inputDetail/taskTodoItems. It must parse cleanly - a hard
    // ZodError here would break agent.getTranscript for the whole chat.
    const legacy = {
      type: "tool_call",
      blockId: "tc-legacy",
      status: "completed",
      timestamp: 1,
      toolName: "Edit",
      input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
      error: null,
    };

    const block = contentBlockSchema.parse(legacy) as ToolCallBlock;
    expect(block.type).toBe("tool_call");
    expect(block.inputSummary).toBeNull();
    expect(block.inputDetail).toBeNull();
    expect(block.taskTodoItems).toBeNull();
    expect(block.endedAt).toBeNull();
    // The dropped raw input - the bloat carrier - is not retained.
    expect("input" in block).toBe(false);
  });

  it("round-trips a current tool_call block with structured input fields", () => {
    const block = contentBlockSchema.parse({
      type: "tool_call",
      blockId: "tc-current",
      status: "completed",
      timestamp: 2,
      toolName: "TaskUpdate",
      inputSummary: "1",
      inputDetail: {
        kind: "fields",
        entries: [{ key: "id", label: "Id", value: "1" }],
      },
      taskTodoItems: [
        {
          id: "1",
          text: null,
          status: "completed",
          priority: null,
          activeForm: null,
          action: "update",
        },
      ],
      error: null,
    }) as ToolCallBlock;
    expect(block.inputSummary).toBe("1");
    expect(block.inputDetail).toEqual({
      kind: "fields",
      entries: [{ key: "id", label: "Id", value: "1" }],
    });
    expect(block.taskTodoItems).toEqual([
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

  it("parses a pre-refactor approval block (raw input) via defaults", () => {
    const block = contentBlockSchema.parse({
      type: "approval",
      blockId: "ap-legacy",
      status: "completed",
      timestamp: 1,
      toolName: "Edit",
      description: null,
      input: { file_path: "/repo/a.ts", old_string: "x" },
      decision: { approved: true, reason: null },
    }) as ApprovalBlock;
    expect(block.type).toBe("approval");
    expect(block.inputSummary).toBeNull();
    expect(block.inputDetail).toBeNull();
    expect("input" in block).toBe(false);
  });

  it("parses a pre-refactor interview block (raw input/output stripped)", () => {
    const block = contentBlockSchema.parse({
      type: "interview",
      blockId: "iv-legacy",
      status: "completed",
      timestamp: 1,
      toolName: "AskUserQuestion",
      title: null,
      description: null,
      questions: [],
      answers: [],
      input: { questions: [{ question: "Q?" }] },
      output: { answer: "A" },
      error: null,
      metadata: null,
    }) as InterviewBlock;
    expect(block.type).toBe("interview");
    expect("input" in block).toBe(false);
    expect("output" in block).toBe(false);
  });

  it("round-trips a current file_change block with hashes and counts", () => {
    const current = {
      type: "file_change",
      blockId: "blk-current",
      status: "completed",
      timestamp: 2,
      filePath: "/repo/src/app.ts",
      operation: "edit",
      diffSource: "snapshot",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      additions: 3,
      deletions: 1,
      reason: "snapshot",
    };

    const block = contentBlockSchema.parse(current) as FileChangeBlock;
    expect(block.beforeHash).toBe("a".repeat(64));
    expect(block.afterHash).toBe("b".repeat(64));
    expect(block.additions).toBe(3);
    expect(block.deletions).toBe(1);
  });

  it("round-trips a plan block with source, preview, actions, and approval linkage", () => {
    const parsed = contentBlockSchema.parse({
      type: "plan",
      blockId: "plan-block-1",
      status: "completed",
      timestamp: 3,
      planStatus: "awaiting_approval",
      planId: "plan-1",
      harnessId: "codex",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      title: "Protocol plan",
      summary: "Add first-class plan protocol support.",
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

    if (parsed.type !== "plan") {
      throw new Error("Expected parsed block to be a plan");
    }
    expect(parsed.planStatus).toBe("awaiting_approval");
    expect(parsed.source.turnId).toBe("turn-1");
    expect(parsed.fullContentRef).toEqual({
      kind: "plan_content",
      hash: "hash-1",
    });
    expect(parsed.actions).toEqual([
      {
        id: "implement",
        label: "Implement",
        decision: "approve",
        variant: "primary",
      },
    ]);
  });

  it("parses a sparse plan block with defaults", () => {
    const parsed = contentBlockSchema.parse({
      type: "plan",
      blockId: "plan-block-sparse",
      status: "streaming",
      timestamp: 4,
      planStatus: "drafting",
      planId: "plan-sparse",
      harnessId: "codex",
      source: {
        harnessId: "codex",
        kind: "provider-plan",
      },
    });

    if (parsed.type !== "plan") {
      throw new Error("Expected parsed block to be a plan");
    }
    expect(parsed.source.sessionId).toBeNull();
    expect(parsed.source.turnId).toBeNull();
    expect(parsed.title).toBeNull();
    expect(parsed.summary).toBeNull();
    expect(parsed.markdownPreview).toBe("");
    expect(parsed.fullContentRef).toBeNull();
    expect(parsed.steps).toEqual([]);
    expect(parsed.actions).toEqual([]);
    expect(parsed.approvalId).toBeNull();
    expect(parsed.supersededByPlanId).toBeNull();
    expect(parsed.metadata).toBeNull();
  });
});
