import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  contentBlockSchema,
  decodeAutonomousResumeBlock,
  encodeAutonomousResumeBlock,
  providerNoticeMetadataSchema,
  providerNoticeNormalizedMetadataSchema,
  subAgentBlockSchema,
  textBlockSchema,
  type ApprovalBlock,
  type AutonomousResumeBlock,
  type FileChangeBlock,
  type InterviewBlock,
  type SubAgentBlock,
  type TextBlock,
  type ToolCallBlock,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";

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

describe("subAgentBlockSchema workflowMeta (no new persisted block type)", () => {
  const workflowSubAgentBlock = {
    type: "subagent",
    blockId: "wf-1",
    status: "completed",
    timestamp: 1000,
    name: "review",
    agentType: null,
    task: "Review the diff",
    progressUpdates: ["Find: find:host-core"],
    result: "3 findings",
    startedAt: 900,
    spawnToolCallId: "toolu_workflow_1",
    stopped: false,
    workflowMeta: {
      name: "review",
      intent: "Review the diff",
      activity: [
        { kind: "phase", text: "Find" },
        { kind: "label", text: "find:host-core" },
      ],
      agentsStarted: 16,
      agentsFinished: 16,
      totalTokens: 120000,
    },
  };

  it("round-trips a dual-written workflow subagent block through the current schema", () => {
    const parsed = subAgentBlockSchema.parse(
      workflowSubAgentBlock,
    ) as SubAgentBlock;
    expect(parsed.name).toBe("review");
    expect(parsed.task).toBe("Review the diff");
    expect(parsed.workflowMeta).toEqual(workflowSubAgentBlock.workflowMeta);
  });

  it("defaults workflowMeta to null for an ordinary (pre-workflow) subagent block", () => {
    const { workflowMeta: _workflowMeta, ...ordinary } = workflowSubAgentBlock;
    const parsed = subAgentBlockSchema.parse(ordinary) as SubAgentBlock;
    expect(parsed.workflowMeta).toBeNull();
  });

  it("old-reader compat: a pre-workflowMeta subAgentBlockSchema parses a workflowMeta-bearing block, stripping the unknown key (plan invariant 6)", () => {
    // Field-for-field copy of `subAgentBlockSchema` as it existed before
    // `workflowMeta` was added - stands in for a released host's baked schema.
    // Persisted bytes must stay readable by any released host (tech plan
    // §2.2 / critique finding 1: no new block `type`, only an
    // additive/defaulted field on the existing `subagent` block). A hard
    // ZodError here would make a chat containing a workflow run entirely
    // unreadable on an older host, not just degraded.
    const preWorkflowMetaSubAgentBlockSchema = z.object({
      blockId: z.string(),
      status: z.enum([
        "streaming",
        "completed",
        "errored",
        "interrupted",
        "superseded",
      ]),
      timestamp: z.number(),
      parentBlockId: z.string().nullish(),
      type: z.literal("subagent"),
      name: z.string().nullable(),
      agentType: z.string().nullable().default(null),
      task: z.string().nullable(),
      progressUpdates: z.array(z.string()),
      result: z.string().nullable(),
      startedAt: z.number().nullable().default(null),
      spawnToolCallId: z.string().nullable().default(null),
      stopped: z.boolean().default(false),
    });

    const parsed = preWorkflowMetaSubAgentBlockSchema.parse(
      workflowSubAgentBlock,
    );
    expect(parsed.type).toBe("subagent");
    expect(parsed.name).toBe("review");
    expect(parsed.result).toBe("3 findings");
    // The rich workflow data is not retained by the older reader - the base
    // subagent fields are the faithful degradation.
    expect("workflowMeta" in parsed).toBe(false);
  });
});

describe("autonomousResumeBlockSchema wakeup persistence compat", () => {
  const baseFields = {
    type: "autonomous_resume" as const,
    blockId: "resume-1",
    status: "completed" as const,
    timestamp: 1,
  };

  it("decodes a raw pre-wakeTriggers stored block (v1.1.3 data, NO schema parse) without throwing", () => {
    // The host's storage hot path (`decodeStoredBlock` in
    // `chat-message-collections.ts`) calls this function on raw Yjs JSON
    // WITHOUT a schema parse, so `.default([])` never runs: every
    // autonomous_resume block written before the wakeTriggers key existed
    // lacks it entirely. Regression: this exact shape crashed every chat
    // open with "Cannot read properties of undefined (reading 'length')".
    const rawV113Stored = {
      ...baseFields,
      triggers: [
        {
          kind: "command" as const,
          title: "cmd",
          status: "completed" as const,
          summary: "ran",
          blockId: "",
          outputFile: null,
          mcp: null,
        },
      ],
      wakeTriggers: undefined,
    };
    const decoded = decodeAutonomousResumeBlock(rawV113Stored);
    expect(decoded.triggers.map((t) => t.kind)).toEqual(["command"]);
    expect("wakeTriggers" in decoded).toBe(false);
  });

  it("parses a legacy pre-fix block with kind:'wakeup' inline in triggers (rc/dev data)", () => {
    const legacy = {
      ...baseFields,
      triggers: [
        {
          kind: "wakeup",
          title: "legacy wake",
          status: "completed",
          summary: "s",
        },
      ],
    };
    const parsed = contentBlockSchema.parse(legacy);
    if (parsed.type !== "autonomous_resume") {
      throw new Error("Expected parsed block to be autonomous_resume");
    }
    expect(parsed.triggers).toEqual([
      {
        kind: "wakeup",
        title: "legacy wake",
        status: "completed",
        summary: "s",
        blockId: "",
        outputFile: null,
        mcp: null,
      },
    ]);
    expect("wakeTriggers" in parsed).toBe(false);
  });

  it("merges the additive wakeTriggers field into triggers, appended after task triggers", () => {
    const stored = {
      ...baseFields,
      triggers: [
        {
          kind: "command",
          title: "cmd",
          status: "completed",
          summary: "ran",
        },
      ],
      wakeTriggers: [{ title: "wake1", status: "completed", summary: "woke" }],
    };
    const parsed = contentBlockSchema.parse(stored);
    if (parsed.type !== "autonomous_resume") {
      throw new Error("Expected parsed block to be autonomous_resume");
    }
    expect(parsed.triggers.map((t) => t.kind)).toEqual(["command", "wakeup"]);
    expect(parsed.triggers[1]).toEqual({
      kind: "wakeup",
      title: "wake1",
      status: "completed",
      summary: "woke",
      blockId: "",
      outputFile: null,
      mcp: null,
    });
    expect("wakeTriggers" in parsed).toBe(false);
  });

  it("v1.1.3 hosts would strip the unknown wakeTriggers key and still parse (empty-marker degradation)", () => {
    // Simulates the OLD closed enum (no "wakeup") plus the absence of the
    // wakeTriggers key entirely - what a v1.1.3 `chatSchema.safeParse` sees
    // once new-host writes have gone through `encodeAutonomousResumeBlock`.
    const oldEnumTriggerSchema = z.object({
      kind: z.enum(["command", "monitor", "subagent"]),
      title: z.string(),
      status: z.enum(["completed", "failed", "stopped"]),
      summary: z.string(),
      blockId: z.string().default(""),
      outputFile: z
        .object({ workspacePath: z.string(), filePath: z.string() })
        .nullable()
        .default(null),
    });
    const oldBlockSchema = z.object({
      type: z.literal("autonomous_resume"),
      blockId: z.string(),
      status: z.enum(["streaming", "completed", "errored"]),
      timestamp: z.number(),
      triggers: z.array(oldEnumTriggerSchema),
    });

    const domain: AutonomousResumeBlock = {
      ...baseFields,
      triggers: [
        {
          kind: "wakeup",
          title: "wake1",
          status: "completed",
          summary: "woke",
          blockId: "",
          outputFile: null,
          mcp: null,
        },
      ],
    };
    const encoded = encodeAutonomousResumeBlock(domain);

    const result = oldBlockSchema.safeParse(encoded);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.triggers).toEqual([]);
    }
  });

  it("round-trips encode -> decode for a mixed trigger set (canonical order: task triggers, then wakeup)", () => {
    const domain: AutonomousResumeBlock = {
      ...baseFields,
      triggers: [
        {
          kind: "subagent",
          title: "sub",
          status: "completed",
          summary: "done",
          blockId: "sub-block",
          outputFile: null,
          mcp: null,
        },
        {
          kind: "wakeup",
          title: "wake1",
          status: "completed",
          summary: "woke",
          blockId: "",
          outputFile: null,
          mcp: null,
        },
      ],
    };

    const encoded = encodeAutonomousResumeBlock(domain);
    expect(encoded.triggers).toHaveLength(1);
    expect(encoded.triggers[0]?.kind).toBe("subagent");
    expect(encoded.wakeTriggers).toEqual([
      { title: "wake1", status: "completed", summary: "woke", blockId: "", outputFile: null },
    ]);

    const decoded = decodeAutonomousResumeBlock(encoded);
    expect(decoded).toEqual(domain);
  });

  it("decode is idempotent - re-decoding an already-domain-shaped block is a no-op", () => {
    const domain: AutonomousResumeBlock = {
      ...baseFields,
      triggers: [
        {
          kind: "wakeup",
          title: "wake1",
          status: "completed",
          summary: "woke",
          blockId: "",
          outputFile: null,
          mcp: null,
        },
      ],
    };
    const reparsed = contentBlockSchema.parse(domain);
    expect(reparsed).toEqual(domain);
  });

  it("z.encode on the full contentBlockSchema union splits wakeup triggers into wakeTriggers", () => {
    const domain: AutonomousResumeBlock = {
      ...baseFields,
      triggers: [
        {
          kind: "wakeup",
          title: "wake1",
          status: "completed",
          summary: "woke",
          blockId: "",
          outputFile: null,
          mcp: null,
        },
      ],
    };
    const encoded = z.encode(contentBlockSchema, domain);
    if (encoded.type !== "autonomous_resume") {
      throw new Error("Expected encoded block to be autonomous_resume");
    }
    expect(encoded.triggers).toEqual([]);
    expect(encoded.wakeTriggers).toEqual([
      { title: "wake1", status: "completed", summary: "woke", blockId: "", outputFile: null },
    ]);
  });

  it("importing hostStreamRpcRegistry succeeds and both JSON-schema IO modes generate without throwing", () => {
    // Regression guard for the actual bug this codec fixes: a plain
    // `.transform()` here would make `hostStreamRpcRegistry`'s module-load-time
    // validation throw "Transforms cannot be represented in JSON Schema" the
    // moment any `chat.subscribe` contract (which embeds `chatSchema`, which
    // embeds this block) gets its fields JSON-schema-serialized.
    expect(Object.keys(hostStreamRpcRegistry)).toContain("chat.subscribe");
    expect(() => z.toJSONSchema(contentBlockSchema)).not.toThrow();
    expect(() => z.toJSONSchema(contentBlockSchema, { io: "input" })).not.toThrow();
  });
});

describe("textBlockSchema providerNotice (no new persisted block type)", () => {
  const modelReroutedBlock = {
    type: "text",
    blockId: "notice-1",
    status: "completed",
    timestamp: 1000,
    text: "Codex switched from gpt-5 to gpt-5-safe (highRiskCyberActivity).",
    providerNotice: {
      harnessId: "codex",
      noticeKind: "model_rerouted",
      tone: "warning",
      title: "Model changed",
      message: "Codex switched from gpt-5 to gpt-5-safe.",
      details: [
        { label: "Reason", value: "highRiskCyberActivity" },
        { label: "From", value: "gpt-5" },
        { label: "To", value: "gpt-5-safe" },
      ],
      metadata: {
        type: "model_rerouted",
        fromModel: "gpt-5",
        toModel: "gpt-5-safe",
        reason: "highRiskCyberActivity",
      },
    },
  };

  it("defaults providerNotice to null for a legacy text block (no providerNotice key)", () => {
    const { providerNotice: _providerNotice, ...legacy } = modelReroutedBlock;
    const parsed = contentBlockSchema.parse(legacy) as TextBlock;
    expect(parsed.type).toBe("text");
    expect(parsed.providerNotice).toBeNull();
  });

  it("round-trips a model_rerouted provider notice text block", () => {
    const parsed = contentBlockSchema.parse(modelReroutedBlock) as TextBlock;
    expect(parsed.type).toBe("text");
    expect(parsed.text).toBe(modelReroutedBlock.text);
    expect(parsed.providerNotice).toEqual(modelReroutedBlock.providerNotice);
  });

  it("round-trips a model_verification provider notice text block", () => {
    const block = {
      type: "text",
      blockId: "notice-2",
      status: "completed",
      timestamp: 1001,
      text: "Model verification active (trustedAccessForCyber).",
      providerNotice: {
        harnessId: "codex",
        noticeKind: "model_verification",
        tone: "info",
        title: "Model verification active",
        message: "trustedAccessForCyber",
        details: [{ label: "Verifications", value: "trustedAccessForCyber" }],
        metadata: {
          type: "model_verification",
          verifications: ["trustedAccessForCyber"],
        },
      },
    };
    const parsed = contentBlockSchema.parse(block) as TextBlock;
    expect(parsed.providerNotice?.metadata).toEqual({
      type: "model_verification",
      verifications: ["trustedAccessForCyber"],
    });
  });

  it("round-trips a safety_buffering provider notice text block, including a null terminalReason while streaming", () => {
    const block = {
      type: "text",
      blockId: "notice-3",
      status: "streaming",
      timestamp: 1002,
      text: "Safety check in progress.",
      providerNotice: {
        harnessId: "codex",
        noticeKind: "safety_buffering",
        tone: "info",
        title: "Safety check in progress",
        message: "Running gpt-5, may fall back to gpt-5-fast.",
        details: [
          { label: "Model", value: "gpt-5" },
          { label: "Faster model", value: "gpt-5-fast" },
        ],
        metadata: {
          type: "safety_buffering",
          model: "gpt-5",
          fasterModel: "gpt-5-fast",
          useCases: ["cyber"],
          reasons: ["highRiskCyberActivity"],
          terminalReason: null,
        },
      },
    };
    const parsed = contentBlockSchema.parse(block) as TextBlock;
    expect(parsed.providerNotice?.metadata).toMatchObject({
      type: "safety_buffering",
      terminalReason: null,
    });
  });

  it("old-reader compat: a pre-providerNotice textBlockSchema parses a providerNotice-bearing block, stripping the unknown key", () => {
    // Field-for-field copy of `textBlockSchema` as it existed before
    // `providerNotice` was added - stands in for a released host's baked
    // schema. A provider-notice text block must stay readable by any
    // released host as plain assistant text (tech plan: compatibility-safe
    // persisted shape, no new `ContentBlock.type`).
    const preProviderNoticeTextBlockSchema = z.object({
      blockId: z.string(),
      status: z.enum(["streaming", "completed", "errored"]),
      timestamp: z.number(),
      parentBlockId: z.string().nullish(),
      type: z.literal("text"),
      text: z.string(),
    });

    const parsed = preProviderNoticeTextBlockSchema.parse(modelReroutedBlock);
    expect(parsed.type).toBe("text");
    expect(parsed.text).toBe(modelReroutedBlock.text);
    // The enrichment is not retained by the older reader - the base text
    // field is the faithful degradation.
    expect("providerNotice" in parsed).toBe(false);
  });

  it("rejects an unknown normalized-metadata discriminant", () => {
    const result = providerNoticeNormalizedMetadataSchema.safeParse({
      type: "unknown_kind",
      value: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a raw/nested provider payload shape outside the normalized metadata union", () => {
    // The generated Codex payload shape (raw threadId/turnId/verifications
    // envelope) must never be accepted as-is - only the normalized,
    // per-notice-kind facts are allowed.
    const result = providerNoticeMetadataSchema.safeParse({
      harnessId: "codex",
      noticeKind: "model_verification",
      tone: "info",
      title: "Model verification active",
      message: null,
      details: [],
      metadata: {
        threadId: "thread-1",
        turnId: "turn-1",
        verifications: ["trustedAccessForCyber"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects provider notice metadata whose type does not match noticeKind", () => {
    const result = providerNoticeMetadataSchema.safeParse({
      harnessId: "codex",
      noticeKind: "model_rerouted",
      tone: "warning",
      title: "Model changed",
      message: null,
      details: [],
      metadata: {
        type: "model_verification",
        verifications: ["trustedAccessForCyber"],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-JSON-serializable values on normalized metadata fields", () => {
    const result = providerNoticeNormalizedMetadataSchema.safeParse({
      type: "model_rerouted",
      fromModel: "gpt-5",
      toModel: "gpt-5-safe",
      reason: () => "highRiskCyberActivity",
    });
    expect(result.success).toBe(false);
  });

  it("textBlockSchema rejects a providerNotice missing required metadata fields", () => {
    const result = textBlockSchema.safeParse({
      type: "text",
      blockId: "notice-invalid",
      status: "completed",
      timestamp: 1,
      text: "fallback",
      providerNotice: {
        harnessId: "codex",
        noticeKind: "model_rerouted",
        tone: "warning",
        // title is required and missing.
        message: null,
        details: [],
        metadata: null,
      },
    });
    expect(result.success).toBe(false);
  });
});
