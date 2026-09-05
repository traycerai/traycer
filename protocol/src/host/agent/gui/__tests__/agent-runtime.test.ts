import { describe, expect, it } from "vitest";
import {
  errorEventSchemaPreFallback,
  runtimeAgentRunInputSchema,
  runtimeApprovalRequestSchema,
  runtimeEventSchema,
  runtimeEventSchemaPreFallback,
  runtimeEventSchemaV12,
  runtimeFailureReason,
  runtimePermissionModeSchema,
  turnInterruptedEventSchemaPreFallback,
} from "@traycer/protocol/host/agent/gui/agent-runtime";

describe("agent runtime stream schema", () => {
  it("accepts the three runtime permission modes", () => {
    expect(runtimePermissionModeSchema.options).toEqual([
      "supervised",
      "auto_accept_edits",
      "full_access",
    ]);
    expect(() => runtimePermissionModeSchema.parse("ask_user")).toThrow();
  });

  it("accepts provider runtime events with sparse stream payloads", () => {
    expect(
      runtimeEventSchema.parse({
        type: "todo.updated",
        blockId: "todo:sess-1",
        timestamp: 1,
        items: [{ text: "Write tests", status: "pending" }],
      }),
    ).toMatchObject({ type: "todo.updated" });

    expect(
      runtimeEventSchema.parse({
        type: "interview.requested",
        blockId: "tool-1:interview",
        timestamp: 2,
        toolName: "AskUserQuestion",
        questions: [
          {
            questionId: null,
            question: "Which SDK?",
            header: null,
            options: [{ label: "Claude", description: null, preview: null }],
            multiSelect: false,
          },
        ],
      }),
    ).toMatchObject({ type: "interview.requested" });

    expect(
      runtimeEventSchema.parse({
        type: "compaction.completed",
        blockId: "compaction:sess-1",
        timestamp: 3,
      }),
    ).toMatchObject({ type: "compaction.completed" });

    expect(
      runtimeEventSchema.parse({
        type: "turn.stopped",
        blockId: "turn-1",
        timestamp: 4,
        turnId: "turn-1",
      }),
    ).toMatchObject({ type: "turn.stopped" });

    expect(
      runtimeEventSchema.parse({
        type: "turn.interrupted",
        blockId: "turn-2",
        timestamp: 5,
        turnId: "turn-2",
        reason: "provider disconnected",
        recoverable: true,
      }),
    ).toMatchObject({ type: "turn.interrupted" });

    expect(
      runtimeEventSchema.parse({
        type: "user_message.anchor_resolved",
        messageId: "message_1",
        blockId: "msg_1",
        timestamp: 6,
        anchor: {
          harnessId: "opencode",
          sessionId: "ses_1",
          opencodeUserMessageId: "msg_1",
        },
      }),
    ).toMatchObject({
      type: "user_message.anchor_resolved",
      anchor: { harnessId: "opencode" },
    });

    expect(
      runtimeEventSchema.parse({
        type: "user_message.anchor_resolved",
        messageId: "message_2",
        blockId: "agent_1",
        timestamp: 7,
        anchor: {
          harnessId: "cursor",
          sessionId: "agent_1",
          cursorRunId: null,
        },
      }),
    ).toMatchObject({
      type: "user_message.anchor_resolved",
      anchor: { harnessId: "cursor", cursorRunId: null },
    });

    // Hermes anchor: `hermesSessionId` is the ACP session id, resolved to a
    // string once `session/new` returns and null until then. Both parse.
    expect(
      runtimeEventSchema.parse({
        type: "user_message.anchor_resolved",
        messageId: "message_3",
        blockId: "ses_hermes",
        timestamp: 8,
        anchor: {
          harnessId: "hermes",
          sessionId: "ses_hermes",
          hermesSessionId: "ses_hermes",
        },
      }),
    ).toMatchObject({
      type: "user_message.anchor_resolved",
      anchor: { harnessId: "hermes", hermesSessionId: "ses_hermes" },
    });

    expect(
      runtimeEventSchema.parse({
        type: "user_message.anchor_resolved",
        messageId: "message_4",
        blockId: "ses_hermes_pending",
        timestamp: 9,
        anchor: {
          harnessId: "hermes",
          sessionId: "ses_hermes_pending",
          hermesSessionId: null,
        },
      }),
    ).toMatchObject({
      type: "user_message.anchor_resolved",
      anchor: { harnessId: "hermes", hermesSessionId: null },
    });
  });

  it("accepts runtime plan events", () => {
    const source = {
      harnessId: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "provider-plan",
    };

    expect(
      runtimeEventSchema.parse({
        type: "plan.delta",
        blockId: "plan-block-1",
        timestamp: 1,
        planId: "plan-1",
        source,
        delta: "1. Inspect protocol\n",
      }),
    ).toMatchObject({
      type: "plan.delta",
      planId: "plan-1",
      delta: "1. Inspect protocol\n",
    });

    expect(
      runtimeEventSchema.parse({
        type: "plan.updated",
        blockId: "plan-block-1",
        timestamp: 2,
        planId: "plan-1",
        source,
        planStatus: "awaiting_approval",
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
        metadata: { providerEvent: "turn/plan/updated" },
      }),
    ).toMatchObject({
      type: "plan.updated",
      planStatus: "awaiting_approval",
      approvalId: "approval-1",
      fullContentRef: { kind: "plan_content", hash: "hash-1" },
    });

    expect(
      runtimeEventSchema.parse({
        type: "plan.completed",
        blockId: "plan-block-1",
        timestamp: 3,
        planId: "plan-1",
        source,
      }),
    ).toMatchObject({
      type: "plan.completed",
      planStatus: "ready",
      approvalId: null,
    });
  });

  it("accepts the tool-progress / cost / turn-reason additions", () => {
    expect(
      runtimeEventSchema.parse({
        type: "tool_call.progress",
        blockId: "tool-1",
        timestamp: 1,
        update: "Fetched 3/10 pages",
      }),
    ).toMatchObject({
      type: "tool_call.progress",
      update: "Fetched 3/10 pages",
    });

    expect(
      runtimeEventSchema.parse({
        type: "usage.updated",
        blockId: "turn-1",
        timestamp: 2,
        turnId: "turn-1",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          costUsd: 0.0123,
        },
      }),
    ).toMatchObject({ type: "usage.updated", usage: { costUsd: 0.0123 } });

    expect(
      runtimeEventSchema.parse({
        type: "turn.completed",
        blockId: "turn-1",
        timestamp: 3,
        turnId: "turn-1",
        reason: "max_tokens",
      }),
    ).toMatchObject({ type: "turn.completed", reason: "max_tokens" });

    // reason stays optional - a clean completion omits it.
    expect(
      runtimeEventSchema.parse({
        type: "turn.completed",
        blockId: "turn-2",
        timestamp: 4,
        turnId: "turn-2",
      }),
    ).toMatchObject({ type: "turn.completed" });
  });

  it("accepts a provider_notice.upsert event on the live minor only (chat.subscribe@1.3+)", () => {
    const event = {
      type: "provider_notice.upsert",
      blockId: "provider-notice:codex:turn-1:model-rerouted",
      timestamp: 1,
      parentBlockId: null,
      harnessId: "codex",
      noticeKind: "model_rerouted",
      tone: "warning",
      status: "completed",
      title: "Model changed",
      message: "Codex switched from gpt-5 to gpt-5-safe.",
      details: [{ label: "Reason", value: "highRiskCyberActivity" }],
      fallbackText:
        "Codex switched from gpt-5 to gpt-5-safe (highRiskCyberActivity).",
      metadata: {
        type: "model_rerouted",
        fromModel: "gpt-5",
        toModel: "gpt-5-safe",
        reason: "highRiskCyberActivity",
      },
    };

    expect(runtimeEventSchema.parse(event)).toMatchObject({
      type: "provider_notice.upsert",
      noticeKind: "model_rerouted",
    });

    // The frozen pre-1.3 union must never accept this event - a real 1.2
    // peer can never produce it, and the wire projection relies on this
    // rejection staying true (see chat-frame-projection.ts).
    expect(runtimeEventSchemaV12.safeParse(event).success).toBe(false);
  });

  it("rejects a provider_notice.upsert event with an empty legacy fallback text", () => {
    expect(
      runtimeEventSchema.safeParse({
        type: "provider_notice.upsert",
        blockId: "provider-notice:codex:turn-1:model-rerouted",
        timestamp: 1,
        parentBlockId: null,
        harnessId: "codex",
        noticeKind: "model_rerouted",
        tone: "warning",
        status: "completed",
        title: "Model changed",
        message: "Codex switched from gpt-5 to gpt-5-safe.",
        details: [{ label: "Reason", value: "highRiskCyberActivity" }],
        fallbackText: "",
        metadata: {
          type: "model_rerouted",
          fromModel: "gpt-5",
          toModel: "gpt-5-safe",
          reason: "highRiskCyberActivity",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown runtime event types", () => {
    expect(() =>
      runtimeEventSchema.parse({
        type: "unknown",
        blockId: "block-1",
        timestamp: 1,
      }),
    ).toThrow();
  });

  it("accepts serializable runtime input and approval request shapes", () => {
    expect(
      runtimeAgentRunInputSchema.parse({
        harnessId: "claude",
        prompt: "Build the thing",
        model: "claude-sonnet-4-5",
        reasoningEffort: "high",
        imageAttachments: [
          {
            fileName: "diagram.png",
            b64content: "aW1hZ2U=",
            url: "file://diagram.png",
            altText: "Architecture diagram",
          },
        ],
        permissionMode: "supervised",
        providerWorkspace: {
          workspaceKind: "provider",
          primaryWorkspace: "/tmp/project",
          secondaryWorkspaces: [],
        },
        slashInvocation: {
          kind: "skill",
          name: "frontend-design",
          arguments: "dashboard",
          path: "/tmp/project/.agents/skills/frontend-design/SKILL.md",
          metadata: {
            path: "/tmp/project/.agents/skills/frontend-design/SKILL.md",
          },
        },
        skillInvocations: [
          {
            name: "frontend-design",
            path: "/tmp/project/.agents/skills/frontend-design/SKILL.md",
            metadata: {},
          },
          {
            name: "react-best-practices",
            path: "/tmp/project/.agents/skills/react-best-practices/SKILL.md",
            metadata: {},
          },
        ],
      }),
    ).toMatchObject({
      harnessId: "claude",
      providerWorkspace: {
        workspaceKind: "provider",
        primaryWorkspace: "/tmp/project",
        secondaryWorkspaces: [],
      },
      systemPrompt: null,
      slashInvocation: { kind: "skill", name: "frontend-design" },
      skillInvocations: [
        { name: "frontend-design" },
        { name: "react-best-practices" },
      ],
    });

    expect(
      runtimeApprovalRequestSchema.parse({
        approvalId: "approval-1",
        toolName: "Bash",
        description: "Run tests",
        input: { command: "bun test" },
      }),
    ).toMatchObject({ approvalId: "approval-1" });
  });

  it("leaves skillInvocations undefined for callers that omit it", () => {
    const parsed = runtimeAgentRunInputSchema.parse({
      harnessId: "claude",
      prompt: "Build the thing",
      model: "claude-sonnet-4-5",
      reasoningEffort: "high",
      permissionMode: "supervised",
      providerWorkspace: {
        workspaceKind: "provider",
        primaryWorkspace: "/tmp/project",
        secondaryWorkspaces: [],
      },
    });

    // `skillInvocations` is `.optional()` with no `.default()` - an older
    // caller created before multi-skill composer support omits the field
    // entirely, and the schema must not backfill it with `[]`.
    expect(parsed.skillInvocations).toBeUndefined();
    expect("skillInvocations" in parsed).toBe(false);
  });
});

// ─── `failure` on the two terminal runtime events (ticket 01, chat.subscribe@1.9) ───
describe("runtimeFailureReason", () => {
  it("is the identity conversion - the compile-time proof that host reasons are a subset of the persisted vocabulary", () => {
    expect(runtimeFailureReason("rate_limit")).toBe("rate_limit");
    expect(runtimeFailureReason("auth")).toBe("auth");
  });
});

describe("errorEventSchema / turnInterruptedEventSchema failure round-trip", () => {
  it("round-trips a full failure payload on an error event", () => {
    const withFailure = {
      type: "error" as const,
      blockId: "block-1",
      timestamp: 1,
      message: "rate limited",
      recoverable: true,
      code: "usage_limit_exceeded",
      failure: {
        reason: "rate_limit" as const,
        resetsAt: 1000,
        resetsAtSource: "provider" as const,
        scope: "five_hour",
        providerDetail: "usage_limit_exceeded",
      },
    };
    const parsed = runtimeEventSchema.parse(withFailure);
    expect(parsed).toMatchObject({
      type: "error",
      failure: withFailure.failure,
    });
  });

  it("leaves failure undefined (not null) on an error event that omits it - the wire uses .optional()", () => {
    const parsed = runtimeEventSchema.parse({
      type: "error",
      blockId: "block-1",
      timestamp: 1,
      message: "boom",
      recoverable: false,
    });
    expect(parsed.type === "error" && parsed.failure).toBeUndefined();
    expect(parsed.type === "error" && "failure" in parsed).toBe(false);
  });

  it("round-trips failure on turn.interrupted, and leaves it undefined when omitted", () => {
    const withFailure = runtimeEventSchema.parse({
      type: "turn.interrupted",
      blockId: "turn-1",
      timestamp: 1,
      turnId: "turn-1",
      reason: "provider rate limited",
      failure: { reason: "rate_limit" as const },
    });
    expect(withFailure).toMatchObject({
      type: "turn.interrupted",
      failure: { reason: "rate_limit" },
    });

    const withoutFailure = runtimeEventSchema.parse({
      type: "turn.interrupted",
      blockId: "turn-2",
      timestamp: 2,
      turnId: "turn-2",
      reason: "provider rate limited",
    });
    expect(
      withoutFailure.type === "turn.interrupted" && withoutFailure.failure,
    ).toBeUndefined();
    expect(
      withoutFailure.type === "turn.interrupted" && "failure" in withoutFailure,
    ).toBe(false);
  });
});

describe("pre-fallback frozen runtime-event freezes (released chat.subscribe@1.0-1.8)", () => {
  const errorWithFailure = {
    type: "error" as const,
    blockId: "block-1",
    timestamp: 1,
    message: "rate limited",
    recoverable: true,
    code: "usage_limit_exceeded",
    failure: { reason: "rate_limit" as const },
  };
  const interruptedWithFailure = {
    type: "turn.interrupted" as const,
    blockId: "turn-1",
    timestamp: 1,
    turnId: "turn-1",
    reason: "provider rate limited",
    failure: { reason: "rate_limit" as const },
  };

  it("errorEventSchemaPreFallback strips failure as an unknown key rather than rejecting the event", () => {
    const parsed = errorEventSchemaPreFallback.parse(errorWithFailure);
    expect("failure" in parsed).toBe(false);
    expect(parsed).toMatchObject({ type: "error", message: "rate limited" });
  });

  it("turnInterruptedEventSchemaPreFallback strips failure as an unknown key rather than rejecting the event", () => {
    const parsed = turnInterruptedEventSchemaPreFallback.parse(
      interruptedWithFailure,
    );
    expect("failure" in parsed).toBe(false);
    expect(parsed).toMatchObject({
      type: "turn.interrupted",
      turnId: "turn-1",
    });
  });

  // The structural pin: the frozen runtime-event UNION every released
  // chat.subscribe minor binds must itself route through the frozen error /
  // turn.interrupted members above, not the live ones - a union that lists
  // its members explicitly but points at a live, still-growing member is
  // "frozen" in name only. This is exactly the gap the coordinator found and
  // fixed in this ticket's own protocol half.
  it("runtimeEventSchemaPreFallback (the union every released line binds) strips failure on both terminal members", () => {
    const parsedError = runtimeEventSchemaPreFallback.parse(errorWithFailure);
    expect(parsedError.type === "error" && "failure" in parsedError).toBe(
      false,
    );

    const parsedInterrupted = runtimeEventSchemaPreFallback.parse(
      interruptedWithFailure,
    );
    expect(
      parsedInterrupted.type === "turn.interrupted" &&
        "failure" in parsedInterrupted,
    ).toBe(false);
  });
});
