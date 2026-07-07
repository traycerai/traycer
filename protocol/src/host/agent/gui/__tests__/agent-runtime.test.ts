import { describe, expect, it } from "vitest";
import {
  formatMcpToolName,
  parseMcpToolName,
  runtimeAgentRunInputSchema,
  runtimeApprovalRequestSchema,
  runtimeEventSchema,
  runtimePermissionModeSchema,
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

  it("parses Claude-style mcp names into server + tool on the first delimiter", () => {
    expect(parseMcpToolName("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    });
    // Server names may carry single underscores; only `__` is the delimiter.
    expect(parseMcpToolName("mcp__traycer_a2a__traycer_send_message")).toEqual({
      server: "traycer_a2a",
      tool: "traycer_send_message",
    });
    // A tool name may itself contain `__` - taken as the whole remainder.
    expect(parseMcpToolName("mcp__srv__a__b")).toEqual({
      server: "srv",
      tool: "a__b",
    });
    // Server-only Claude form has no tool component.
    expect(parseMcpToolName("mcp__fetch")).toEqual({
      server: "fetch",
      tool: null,
    });
  });

  it("parses Codex-style mcp names as server-only", () => {
    expect(parseMcpToolName("mcp:deepwiki")).toEqual({
      server: "deepwiki",
      tool: null,
    });
  });

  it("returns null for non-mcp or malformed names", () => {
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("mcp_tool_call")).toBeNull();
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp__ __tool")).toMatchObject({ server: " " });
    expect(parseMcpToolName("mcp:")).toBeNull();
  });

  it("formats mcp names as [server] tool, or [server] when tool-less", () => {
    expect(formatMcpToolName("mcp__github__create_issue")).toBe(
      "[github] create_issue",
    );
    expect(formatMcpToolName("mcp:deepwiki")).toBe("[deepwiki]");
    expect(formatMcpToolName("mcp__fetch")).toBe("[fetch]");
    // Non-mcp falls back to the raw name.
    expect(formatMcpToolName("Bash")).toBe("Bash");
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
});
