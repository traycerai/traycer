import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ChatEvent,
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type { TurnCheckpointManifest } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  ChatActiveTurn,
  ChatQueuedItem,
  ChatQueueSteerMode,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { LiveAssistantMessage } from "@/stores/chats/chat-session-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import type {
  SubagentSegment,
  ToolSegment,
} from "@/stores/composer/chat-store";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import {
  isTaskTodoToolName,
  parseTaskTodoToolPayloads,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";

// Mirror the host accumulator: a persisted tool_call/approval block carries
// precomputed display fields, not the raw input. Computed via the same protocol
// helpers so block fixtures match what the host writes.
function toolCallInputFields(toolName: string, input: unknown) {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
    taskTodoItems: isTaskTodoToolName(toolName)
      ? parseTaskTodoToolPayloads({ toolName, payloads: [input] })
      : null,
  };
}
function approvalInputFields(toolName: string, input: unknown) {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
  };
}

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

// Chat-tile binding identity required by every `RenderedMessagesInput`. Stable
// across renders in real usage, so it's a shared constant spread into each
// fixture; the setup-card integration tests below exercise it directly.
const BINDING = {
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat",
  viewTabId: "tab-1",
} satisfies Pick<
  RenderedMessagesInput,
  "epicId" | "ownerId" | "ownerKind" | "viewTabId"
>;

function userMessage(messageId: string): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: CONTENT,
    },
    timestamp: 1000 + messageId.length,
    sessionAnchor: null,
  };
}

// `userMessage` derives its timestamp from the id length (~1000s), so it can't
// sort after an assistant turn. Use this when a send must land later in time
// (e.g. a mid-chat worktree-creating send issued after an earlier exchange).
function userMessageAt(
  messageId: string,
  timestamp: number,
): Extract<Message, { role: "user" }> {
  return { ...userMessage(messageId), timestamp };
}

function steerRequestedQueueItem(
  queueItemId: string,
  messageId: string,
  mode: ChatQueueSteerMode,
): ChatQueuedItem {
  return {
    queueItemId,
    messageId,
    message: {
      kind: "user",
      content: CONTENT,
    },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: mode === "safe_point" ? "same_turn" : "next_turn",
    status: "steer_requested",
    targetTurnId: "turn-1",
    steerRequest: {
      mode,
      targetTurnId: "turn-1",
      requestedAt: 2000,
    },
    fallbackReason: null,
    createdAt: 1900,
    updatedAt: 2000,
  };
}

function fallbackQueueItem(item: ChatQueuedItem): ChatQueuedItem {
  return {
    ...item,
    delivery: "next_turn",
    status: "fallback",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: "The active turn ended before a safe point appeared.",
    updatedAt: 2100,
  };
}

function queueEvent(input: {
  readonly type: Extract<
    ChatEvent["type"],
    "queue.steerRequested" | "queue.fallback" | "queue.resumed"
  >;
  readonly timestamp: number;
  readonly messageId: string | null;
  readonly queueItemId: string | null;
  readonly metadata: ChatEvent["metadata"];
}): ChatEvent {
  return {
    eventId: `event:${input.type}:${input.timestamp}`,
    type: input.type,
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: "turn-1",
    messageId: input.messageId,
    queueItemId: input.queueItemId,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: input.metadata,
  };
}

function waitEvent(input: {
  readonly type: Extract<
    ChatEvent["type"],
    | "approval.requested"
    | "approval.resolved"
    | "approval.denied"
    | "approval.abandoned"
    | "interview.requested"
    | "interview.resolved"
    | "interview.errored"
  >;
  readonly timestamp: number;
  readonly turnId: string;
  readonly approvalId: string | null;
  readonly blockId: string | null;
}): ChatEvent {
  return {
    eventId: `event:${input.type}:${input.timestamp}`,
    type: input.type,
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: input.turnId,
    messageId: null,
    queueItemId: null,
    approvalId: input.approvalId,
    blockId: input.blockId,
    severity: "info",
    metadata: null,
  };
}

const ASSISTANT_SENDER: AgentSender = {
  type: "agent" as const,
  harnessId: "claude" as const,
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
};

function assistantMessage(
  turnId: string,
  timestamp: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: turnId,
    sender: ASSISTANT_SENDER,
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function checkpointManifest(
  checkpointId: string,
  filePath: string,
): TurnCheckpointManifest {
  return {
    schemaVersion: 1,
    checkpointId,
    capturingUserId: "owner-1",
    capturingHostId: "host-1",
    allowedRoots: ["/repo"],
    workingDirectory: "/repo",
    capturedAt: 2000,
    entries: [
      {
        filePath,
        operation: "edit",
        beforeHash: "before",
        afterHash: "after",
        undoable: true,
        reason: null,
      },
    ],
  };
}

function fileChangeBlock(
  filePath: string,
): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    type: "file_change",
    blockId: `file:${filePath}`,
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    additions: 1,
    deletions: 1,
    reason: "snapshot",
    status: "completed",
    timestamp: 2001,
  };
}

function checkpointEvent(manifest: TurnCheckpointManifest): ChatEvent {
  return {
    eventId: `event:${manifest.checkpointId}`,
    type: "checkpoint.captured",
    timestamp: manifest.capturedAt,
    clientActionId: null,
    actor: null,
    message: "Checkpoint captured.",
    turnId: manifest.checkpointId,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: { ...manifest },
  };
}

function persistedPlanBlock(input: {
  readonly contentHash: string;
  readonly revision: number;
  readonly preview: string;
  readonly timestamp: number;
}): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    type: "plan",
    blockId: "plan:block-1",
    status: "completed",
    timestamp: input.timestamp,
    planStatus: "ready",
    planId: "plan-1",
    harnessId: "codex",
    source: {
      harnessId: "codex",
      sessionId: "session-1",
      turnId: "turn-plan-refresh",
      kind: "structured",
    },
    title: "Stable plan",
    summary: null,
    markdownPreview: input.preview,
    fullContentRef: { kind: "plan_content", hash: input.contentHash },
    steps: [
      {
        id: "step-1",
        text: input.preview,
        status: "pending",
        activeForm: null,
      },
    ],
    actions: [],
    approvalId: null,
    supersededByPlanId: null,
    metadata: { planRevision: input.revision },
  };
}

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: (_sender, reasoningEffort) =>
    reasoningEffort === null ? null : `Resolved ${reasoningEffort}`,
  contentBlocksText: () => "",
};

describe("useRenderedMessages", () => {
  it("projects persisted plan blocks into plan segments", () => {
    const assistant = assistantMessage("turn-plan", 2000);
    const planBlock = {
      type: "plan",
      blockId: "plan:block-1",
      status: "completed",
      timestamp: 2400,
      planStatus: "awaiting_approval",
      planId: "plan-1",
      harnessId: "codex",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-plan",
        kind: "structured",
      },
      title: "Review renderer plan",
      summary: "Render plans as cards.",
      markdownPreview: "## Renderer plan\n- Add a card",
      fullContentRef: { kind: "plan_content", hash: "hash-1" },
      steps: [
        {
          id: "step-1",
          text: "Add a card",
          status: "pending",
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
      metadata: { planRevision: 7 },
    } satisfies Extract<Message, { role: "assistant" }>["blocks"][number];
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [{ ...assistant, blocks: [planBlock] }],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segment = result.current[0]?.segments[0];
    expect(segment.kind).toBe("plan");
    if (segment.kind !== "plan") throw new Error("expected plan segment");
    expect(segment.planId).toBe("plan-1");
    expect(segment.planStatus).toBe("awaiting_approval");
    expect(segment.fullContentRef?.hash).toBe("hash-1");
    expect(segment.contentIdentity).toBe("hash-1");
    expect(segment.actions[0]?.label).toBe("Implement");
  });

  it("does not render a content-less plan block even when it carries actions and an approvalId", () => {
    // A plan only renders once it carries content (markdownPreview / steps /
    // fullContentRef). A status-only block - here `awaiting_approval` with
    // actions + an approvalId but no body - must NOT surface as a blank card.
    const assistant = assistantMessage("turn-empty-actionable-plan", 2000);
    const planBlock = {
      type: "plan",
      blockId: "plan:block-actionable-empty",
      status: "streaming",
      timestamp: 2400,
      planStatus: "awaiting_approval",
      planId: "plan-actionable-empty",
      harnessId: "claude",
      source: {
        harnessId: "claude",
        sessionId: "session-1",
        turnId: "turn-empty-actionable-plan",
        kind: "approval-plan",
      },
      title: "Plan",
      summary: null,
      markdownPreview: "",
      fullContentRef: null,
      steps: [],
      actions: [
        {
          id: "implement",
          label: "Implement",
          decision: "approve",
          variant: "primary",
        },
      ],
      approvalId: "approval-empty-plan",
      supersededByPlanId: null,
      metadata: {},
    } satisfies Extract<Message, { role: "assistant" }>["blocks"][number];

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [{ ...assistant, blocks: [planBlock] }],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    expect(segments.some((segment) => segment.kind === "plan")).toBe(false);
  });

  it("refreshes a stable plan segment when its content identity changes", () => {
    const assistant = assistantMessage("turn-plan-refresh", 2000);
    const initial = {
      messages: [
        {
          ...assistant,
          blocks: [
            persistedPlanBlock({
              contentHash: "hash-1",
              revision: 1,
              preview: "## First plan\n- First step",
              timestamp: 2400,
            }),
          ],
        },
      ],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle" as const,
      ...BINDING,
    };
    const updated = {
      ...initial,
      messages: [
        {
          ...assistant,
          blocks: [
            persistedPlanBlock({
              contentHash: "hash-2",
              revision: 2,
              preview: "## Second plan\n- Second step",
              timestamp: 2400,
            }),
          ],
        },
      ],
    };

    const { result, rerender } = renderHook(
      ({ input }: { readonly input: RenderedMessagesInput }) =>
        useRenderedMessages(input, displayContext),
      { initialProps: { input: initial } },
    );
    const firstSegment = result.current[0]?.segments[0];
    expect(firstSegment.kind).toBe("plan");
    if (firstSegment.kind !== "plan") throw new Error("expected plan segment");
    expect(firstSegment.contentIdentity).toBe("hash-1");
    expect(firstSegment.markdownPreview).toContain("First plan");

    rerender({ input: updated });

    const secondSegment = result.current[0]?.segments[0];
    expect(secondSegment.kind).toBe("plan");
    if (secondSegment.kind !== "plan") throw new Error("expected plan segment");
    expect(secondSegment.planId).toBe("plan-1");
    expect(secondSegment.contentIdentity).toBe("hash-2");
    expect(secondSegment.markdownPreview).toContain("Second plan");
  });

  it("continues projecting persisted text, todo, and generic approval blocks without plan conversion", () => {
    const assistant = assistantMessage("turn-old-flows", 2000);
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [
            {
              ...assistant,
              blocks: [
                {
                  type: "text",
                  blockId: "text-1",
                  status: "completed",
                  timestamp: 2010,
                  providerNotice: null,
                  text: "Normal assistant text.",
                },
                {
                  type: "todo",
                  blockId: "todo-1",
                  status: "completed",
                  timestamp: 2020,
                  items: [
                    {
                      id: "todo-item-1",
                      text: "Generic checklist item",
                      status: "pending",
                      priority: null,
                      activeForm: null,
                    },
                  ],
                },
                {
                  type: "approval",
                  blockId: "approval-1",
                  status: "completed",
                  timestamp: 2030,
                  toolName: "Shell",
                  description: "Run command",
                  ...approvalInputFields("Shell", { command: "pwd" }),
                  decision: null,
                },
              ],
            },
          ],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "todo",
      "approval",
    ]);
    expect(segments[1]).toMatchObject({
      kind: "todo",
      items: [expect.objectContaining({ text: "Generic checklist item" })],
    });
    expect(segments[2]).toMatchObject({
      kind: "approval",
      toolName: "Shell",
      decision: null,
    });
  });

  it("projects a text block with providerNotice into a provider_notice segment while an ordinary text block stays a text segment", () => {
    const assistant = assistantMessage("turn-notice", 2000);
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [
            {
              ...assistant,
              blocks: [
                {
                  type: "text",
                  blockId: "text-1",
                  status: "completed",
                  timestamp: 2001,
                  text: "Plain assistant reply.",
                  providerNotice: null,
                },
                {
                  type: "text",
                  blockId: "text-2",
                  status: "completed",
                  timestamp: 2002,
                  text: "Codex switched from gpt-5 to gpt-5-safe.",
                  providerNotice: {
                    harnessId: "codex",
                    noticeKind: "model_rerouted",
                    tone: "warning",
                    title: "Model changed",
                    message: "Codex switched from gpt-5 to gpt-5-safe.",
                    details: [
                      { label: "Reason", value: "highRiskCyberActivity" },
                    ],
                    metadata: {
                      type: "model_rerouted",
                      fromModel: "gpt-5",
                      toModel: "gpt-5-safe",
                      reason: "highRiskCyberActivity",
                    },
                  },
                },
              ],
            },
          ],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "provider_notice",
    ]);
    const notice = segments[1];
    if (notice.kind !== "provider_notice") {
      throw new Error("expected a provider_notice segment");
    }
    expect(notice.status).toBe("completed");
    expect(notice.tone).toBe("warning");
    expect(notice.title).toBe("Model changed");
    expect(notice.message).toBe("Codex switched from gpt-5 to gpt-5-safe.");
    expect(notice.details).toEqual([
      { label: "Reason", value: "highRiskCyberActivity" },
    ]);
    expect(notice.parentId).toBeNull();
  });

  it("caches user-message renders by Message reference identity", () => {
    const u1 = userMessage("m1");
    const u2 = userMessage("m2");
    const messages = [u1, u2];
    const input: RenderedMessagesInput = {
      messages,
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: typeof input }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: input } },
    );
    const first = result.current;

    // Re-render with same input - every model should be the same reference.
    rerender({ value: input });
    const second = result.current;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("invalidates only the changed message slot when messages array is replaced", () => {
    const u1 = userMessage("m1");
    const u2 = userMessage("m2");
    const initial: RenderedMessagesInput = {
      messages: [u1, u2],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: typeof initial }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: initial } },
    );
    const first = result.current;

    // Replace `u2` with a new reference (simulating the streaming-row
    // replaceMessageAt path). `u1` reference is preserved so its cached
    // model survives.
    const u2Replaced = userMessage("m2");
    rerender({
      value: {
        ...initial,
        messages: [u1, u2Replaced],
      },
    });
    const second = result.current;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it("returns assistant rows when an assistant message exists", () => {
    const a = {
      ...assistantMessage("turn-1", 2000),
      messageId: "assistant-message-1",
    };
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [a],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.role).toBe("assistant");
    expect(result.current[0]?.id).toBe("assistant:turn-1");
    expect(result.current[0]?.persistentMessageId).toBe("assistant-message-1");
  });

  it("uses the latest assistant message id for a coalesced assistant turn", () => {
    const first = {
      ...assistantMessage("turn-1", 2000),
      messageId: "assistant-message-1",
    };
    const second = {
      ...assistantMessage("turn-1", 2400),
      messageId: "assistant-message-2",
    };
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [first, second],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.persistentMessageId).toBe("assistant-message-2");
  });

  it("preserves structured agent-message payloads without changing row identity", () => {
    const message: Extract<Message, { role: "user" }> = {
      ...userMessage("agent-message-1"),
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "agent-sender-1",
        displayName: "Review Agent",
        reply: { expectsReply: true, responseId: "response-1" },
      },
      message: {
        kind: "agent",
        content: CONTENT,
        fromAgentId: "agent-sender-1",
        senderTitle: "Review Agent",
        senderHarnessId: "harness-1",
        reply: { expectsReply: true, responseId: "response-1" },
      },
      sessionAnchor: {
        profileId: null,
        labelSnapshot: null,
        accountUuid: null,
        accentColor: null,
        harnessId: "codex",
        hostId: "host-1",
        sessionId: "session-1",
        sessionWorkspaceSnapshot: {
          workspaceKind: "session-snapshot",
          primaryWorkspace: "/repo",
          secondaryWorkspaces: [],
        },
        codexTurnId: "turn-1",
        codexUserMessageId: "codex-user-1",
        createdAt: 1000,
        coveredUntilMessageId: null,
      },
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [message],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]).toMatchObject({
      id: "agent-message-1",
      persistentMessageId: "agent-message-1",
      role: "user",
      agentMessage: message.message.kind === "agent" ? message.message : null,
      sessionAnchor: message.sessionAnchor,
    });
  });

  it("threads per-turn run metadata onto the assistant row's assistantMeta", () => {
    // Distinct turnId so this turn doesn't reuse another test's cached model
    // (the per-turn cache keys on the shared display context + turnKey).
    const a: Extract<Message, { role: "assistant" }> = {
      ...assistantMessage("turn-meta", 2000),
      reasoningEffort: "high",
      serviceTier: "priority",
    };
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [a],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    // `provider` comes from the sender's harnessId; the labels come from the
    // display context; reasoningEffort/serviceTier flow from the persisted
    // message through the turn accumulator.
    expect(result.current[0]?.assistantMeta).toEqual({
      provider: "claude",
      providerLabel: "Claude Code",
      modelLabel: null,
      reasoningEffort: "high",
      reasoningEffortLabel: "Resolved high",
      serviceTier: "priority",
      costUsd: null,
    });
  });

  it("threads the turn's cost onto assistantMeta for the completion footer", () => {
    const a: Extract<Message, { role: "assistant" }> = {
      ...assistantMessage("turn-cost", 2000),
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.0456,
      },
    };
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [a],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    expect(result.current[0]?.assistantMeta?.costUsd).toBe(0.0456);
  });

  it("renders confirmed steer blocks even before the persisted user row arrives", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "steer",
          blockId: "steer:queue-1",
          status: "completed",
          timestamp: 2001,
          queueItemId: "queue-1",
          messageId: "message-queue-1",
          mode: "safe_point",
          sender: null,
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "run lint next" }],
              },
            ],
          },
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      id: "steer:queue-1",
      role: "user",
      content: "run lint next",
      persistentMessageId: null,
      steerBadge: { status: "steered", mode: "safe_point" },
    });
  });

  it("splits assistant output around steered user bubbles", () => {
    const content = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "follow up" }],
        },
      ],
    };
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "text",
          blockId: "before",
          text: "Before steer",
          status: "completed",
          timestamp: 2001,
          providerNotice: null,
        },
        {
          type: "steer",
          blockId: "steer:queue-1",
          status: "completed",
          timestamp: 2002,
          queueItemId: "queue-1",
          messageId: "message-queue-1",
          mode: "safe_point",
          sender: null,
          content,
        },
        {
          type: "text",
          blockId: "after",
          text: "After steer",
          status: "completed",
          timestamp: 2003,
          providerNotice: null,
        },
      ],
    };
    const steered: Message = {
      ...userMessage("message-queue-1"),
      message: {
        kind: "user",
        content,
      },
      timestamp: 2002,
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant, steered],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result.current[0]?.segments).toMatchObject([
      { kind: "text", markdown: "Before steer" },
    ]);
    expect(result.current[1]).toMatchObject({
      id: "message-queue-1",
      role: "user",
      content: "follow up",
      persistentMessageId: "message-queue-1",
      steerBadge: { status: "steered", mode: "safe_point" },
    });
    expect(result.current[2]?.segments).toMatchObject([
      { kind: "text", markdown: "After steer" },
    ]);
  });

  it("renders persisted steered user messages at the steer point", () => {
    const content = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "follow up" }],
        },
      ],
    };
    const before: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "text",
          blockId: "before",
          text: "Before steer",
          status: "completed",
          timestamp: 2001,
          providerNotice: null,
        },
      ],
    };
    const steered: Message = {
      ...userMessage("message-queue-1"),
      message: {
        kind: "user",
        content,
      },
      timestamp: 2002,
    };
    const after: Message = {
      ...assistantMessage("turn-1", 2003),
      blocks: [
        {
          type: "steer",
          blockId: "steer:queue-1",
          status: "completed",
          timestamp: 2002,
          queueItemId: "queue-1",
          messageId: "message-queue-1",
          mode: "safe_point",
          sender: null,
          content,
        },
        {
          type: "text",
          blockId: "after",
          text: "After steer",
          status: "completed",
          timestamp: 2003,
          providerNotice: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [before, steered, after],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result.current[1]).toMatchObject({
      id: "message-queue-1",
      role: "user",
      content: "follow up",
      persistentMessageId: "message-queue-1",
      steerBadge: { status: "steered", mode: "safe_point" },
    });
  });

  it("does not render unconfirmed queue steers as in-chat user bubbles", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistantMessage("turn-1", 2000)],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: {
            turnId: "turn-1",
            status: "running",
            harnessId: "claude",
            model: "claude-sonnet-4-5",
            agentMode: "regular",
            profileId: null,
            userMessageId: null,
            startedAt: 1,
            updatedAt: 2,
            reasoningEffort: null,
            serviceTier: null,
          },
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(
      result.current.some((message) => message.id === "steer:queue-1"),
    ).toBe(false);
    expect(result.current.map((message) => message.role)).toEqual([
      "assistant",
    ]);
  });

  it("badges interrupt-restart queued user rows as steered", () => {
    const requested = steerRequestedQueueItem(
      "queue-interrupt",
      "message-interrupt",
      "interrupt_restart",
    );

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("message-interrupt")],
          events: [
            queueEvent({
              type: "queue.steerRequested",
              timestamp: 2000,
              messageId: "message-interrupt",
              queueItemId: "queue-interrupt",
              metadata: { items: [requested] },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]).toMatchObject({
      role: "user",
      persistentMessageId: "message-interrupt",
      steerBadge: { status: "steered", mode: null },
    });
  });

  it("does not badge downgraded safe-point fallback rows as steered", () => {
    const requested = steerRequestedQueueItem(
      "queue-safe",
      "message-safe",
      "safe_point",
    );
    const fallback = fallbackQueueItem(requested);

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("message-safe")],
          events: [
            queueEvent({
              type: "queue.steerRequested",
              timestamp: 2000,
              messageId: "message-safe",
              queueItemId: "queue-safe",
              metadata: { items: [requested] },
            }),
            queueEvent({
              type: "queue.fallback",
              timestamp: 2100,
              messageId: "message-safe",
              queueItemId: "queue-safe",
              metadata: { item: fallback },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]).toMatchObject({
      role: "user",
      persistentMessageId: "message-safe",
      steerBadge: null,
    });
  });

  it("keeps active interrupt-restart badges when broad queue metadata contains unrelated fallback items", () => {
    const interruptRequest = steerRequestedQueueItem(
      "queue-interrupt",
      "message-interrupt",
      "interrupt_restart",
    );
    const safePointRequest = steerRequestedQueueItem(
      "queue-safe",
      "message-safe",
      "safe_point",
    );
    const safePointFallback = fallbackQueueItem(safePointRequest);

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [
            userMessage("message-interrupt"),
            userMessage("message-safe"),
          ],
          events: [
            queueEvent({
              type: "queue.steerRequested",
              timestamp: 2000,
              messageId: "message-interrupt",
              queueItemId: "queue-interrupt",
              metadata: { items: [interruptRequest, safePointRequest] },
            }),
            queueEvent({
              type: "queue.fallback",
              timestamp: 2100,
              messageId: "message-safe",
              queueItemId: "queue-safe",
              metadata: { items: [interruptRequest, safePointFallback] },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const interruptRow = result.current.find(
      (message) => message.persistentMessageId === "message-interrupt",
    );
    const safePointRow = result.current.find(
      (message) => message.persistentMessageId === "message-safe",
    );

    expect(interruptRow).toMatchObject({
      role: "user",
      persistentMessageId: "message-interrupt",
      steerBadge: { status: "steered", mode: null },
    });
    expect(safePointRow).toMatchObject({
      role: "user",
      persistentMessageId: "message-safe",
      steerBadge: null,
    });
  });

  it("invalidates assistant turn cache when a non-last block status changes", () => {
    const streamingAssistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "text",
          blockId: "text-1",
          text: "Thinking aloud",
          status: "streaming",
          timestamp: 2001,
          providerNotice: null,
        },
        {
          type: "command",
          blockId: "command-1",
          command: "pwd",
          cwd: "/repo",
          exitCode: null,
          status: "streaming",
          timestamp: 2002,
        },
      ],
    };
    const completedTextAssistant: Message = {
      ...streamingAssistant,
      blocks: [
        {
          type: "text",
          blockId: "text-1",
          text: "Thinking aloud",
          status: "completed",
          timestamp: 2003,
          providerNotice: null,
        },
        streamingAssistant.blocks[1],
      ],
    };
    const input: RenderedMessagesInput = {
      messages: [streamingAssistant],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "running",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: input } },
    );
    const streamingSegment = result.current[0].segments[0];
    expect(streamingSegment.kind).toBe("text");
    if (streamingSegment.kind !== "text") {
      throw new Error("expected text segment");
    }
    expect(streamingSegment.isStreaming).toBe(true);

    rerender({
      value: {
        ...input,
        messages: [completedTextAssistant],
      },
    });

    const completedSegment = result.current[0].segments[0];
    expect(completedSegment.kind).toBe("text");
    if (completedSegment.kind !== "text") {
      throw new Error("expected text segment");
    }
    expect(completedSegment.isStreaming).toBe(false);
  });

  it("invalidates assistant turn cache when text changes without a timestamp change", () => {
    const partialAssistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "text",
          blockId: "text-1",
          text: "Hel",
          status: "streaming",
          timestamp: 2001,
          providerNotice: null,
        },
      ],
    };
    const expandedAssistant: Message = {
      ...partialAssistant,
      blocks: [
        {
          type: "text",
          blockId: "text-1",
          text: "Hello",
          status: "streaming",
          timestamp: 2001,
          providerNotice: null,
        },
      ],
    };
    const input: RenderedMessagesInput = {
      messages: [partialAssistant],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "running",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: input } },
    );

    rerender({
      value: {
        ...input,
        messages: [expandedAssistant],
      },
    });

    const segment = result.current[0].segments[0];
    expect(segment.kind).toBe("text");
    if (segment.kind !== "text") {
      throw new Error("expected text segment");
    }
    expect(segment.markdown).toBe("Hello");
  });

  it("invalidates the cached provider_notice segment when its title changes without a length or timestamp change", () => {
    const providerNoticeBlock = (title: string) => ({
      type: "text" as const,
      blockId: "text-1",
      // Fixed fallback text: only the enriched notice fields change below, so
      // `block.text.length` alone (the ordinary text-block signature) would
      // NOT catch this update.
      text: "Notice.",
      status: "completed" as const,
      timestamp: 2001,
      providerNotice: {
        harnessId: "codex" as const,
        noticeKind: "model_rerouted" as const,
        tone: "warning" as const,
        title,
        message: null,
        details: [],
        metadata: null,
      },
    });
    const before: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [providerNoticeBlock("Model changed")],
    };
    const after: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [providerNoticeBlock("Model re-verified")],
    };
    const input: RenderedMessagesInput = {
      messages: [before],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: input } },
    );
    const firstSegment = result.current[0]?.segments[0];
    expect(firstSegment.kind).toBe("provider_notice");
    if (firstSegment.kind !== "provider_notice") {
      throw new Error("expected a provider_notice segment");
    }
    expect(firstSegment.title).toBe("Model changed");

    rerender({ value: { ...input, messages: [after] } });

    const secondSegment = result.current[0]?.segments[0];
    expect(secondSegment.kind).toBe("provider_notice");
    if (secondSegment.kind !== "provider_notice") {
      throw new Error("expected a provider_notice segment");
    }
    expect(secondSegment.title).toBe("Model re-verified");
  });

  it("uses host-supplied blocksVersion to invalidate assistant turn cache", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocksVersion: 1,
      blocks: [
        {
          type: "text",
          blockId: "text-1",
          text: "Hello",
          status: "completed",
          timestamp: 2001,
          providerNotice: null,
        },
      ],
    };
    const input: RenderedMessagesInput = {
      messages: [assistant],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: input } },
    );
    const first = result.current[0];

    rerender({
      value: {
        ...input,
        messages: [{ ...assistant, blocksVersion: 2 }],
      },
    });

    expect(result.current[0]).not.toBe(first);
  });

  it("keeps operational assistant blocks flat for display-time grouping", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "text",
          blockId: "text-1",
          text: "Checking.",
          status: "completed",
          timestamp: 2001,
          providerNotice: null,
        },
        {
          type: "tool_call",
          blockId: "tool-1",
          toolName: "read_file",
          ...toolCallInputFields("read_file", { path: "/repo/src/app.ts" }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "completed",
          timestamp: 2002,
          startedAt: 2002,
          endedAt: 2002,
        },
        {
          type: "command",
          blockId: "command-1",
          command: "bun test",
          cwd: "/repo",
          exitCode: 0,
          status: "completed",
          timestamp: 2003,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]?.segments.map((segment) => segment.kind)).toEqual([
      "text",
      "tool",
      "command",
    ]);
  });

  it("drops a resume trigger whose blockId is the immediately preceding tool segment", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "tool-1",
          toolName: "Bash",
          ...toolCallInputFields("Bash", { command: "bun run compile" }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: true,
          stopped: false,
          status: "completed",
          timestamp: 2002,
          startedAt: 2002,
          endedAt: 2002,
        },
        {
          type: "autonomous_resume",
          blockId: "resume-1",
          status: "completed",
          timestamp: 2003,
          triggers: [
            {
              kind: "command",
              title: "bun run compile",
              status: "completed",
              summary: "Command finished",
              blockId: "tool-1",
              outputFile: null,
            },
          ],
        },
        {
          type: "text",
          blockId: "text-1",
          text: "Now let's type-check.",
          status: "completed",
          timestamp: 2004,
          providerNotice: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]?.segments.map((segment) => segment.kind)).toEqual([
      "tool",
      "text",
    ]);
  });

  it("keeps a wakeup resume trigger even when its blockId is the immediately preceding tool segment", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "wake-tool",
          toolName: "ScheduleWakeup",
          ...toolCallInputFields("ScheduleWakeup", {
            reason: "Review the deployment",
            prompt: "Check the health dashboard.",
          }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "completed",
          timestamp: 2002,
          startedAt: 2002,
          endedAt: 2002,
        },
        {
          type: "autonomous_resume",
          blockId: "resume-1",
          status: "completed",
          timestamp: 2003,
          triggers: [
            {
              kind: "wakeup",
              title: "Review the deployment",
              status: "completed",
              summary: "Check the health dashboard.",
              blockId: "wake-tool",
              outputFile: null,
            },
          ],
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]?.segments.map((segment) => segment.kind)).toEqual([
      "tool",
      "autonomous_resume",
    ]);
  });

  it("keeps a resume trigger whose blockId is not the immediately preceding segment", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "tool-1",
          toolName: "Bash",
          ...toolCallInputFields("Bash", { command: "bun run compile" }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: true,
          stopped: false,
          status: "completed",
          timestamp: 2002,
          startedAt: 2002,
          endedAt: 2002,
        },
        {
          type: "text",
          blockId: "text-1",
          text: "Now let's also check this other thing.",
          providerNotice: null,
          status: "completed",
          timestamp: 2003,
        },
        {
          type: "autonomous_resume",
          blockId: "resume-1",
          status: "completed",
          timestamp: 2004,
          triggers: [
            {
              kind: "command",
              title: "bun run compile",
              status: "completed",
              summary: "Command finished",
              blockId: "tool-1",
              outputFile: null,
            },
          ],
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]?.segments.map((segment) => segment.kind)).toEqual([
      "tool",
      "text",
      "autonomous_resume",
    ]);
  });

  it("drops a resume trigger for a subagent whose last raw child segment differs from the visible parent card", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "Investigate lifecycle",
          task: "Investigate the lifecycle.",
          progressUpdates: [],
          result: "Done.",
          status: "completed",
          timestamp: 2001,
          startedAt: 2000,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "tool_call",
          blockId: "child-tool-1",
          parentBlockId: "agent-1",
          toolName: "read_file",
          ...toolCallInputFields("read_file", { path: "/repo/src/app.ts" }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "completed",
          timestamp: 2002,
          startedAt: 2002,
          endedAt: 2002,
        },
        {
          // The resume trigger's blockId targets the subagent itself, but in
          // raw block order the immediately preceding block is the child tool
          // call nested under it - the scenario suppressRedundantResumeMarkers
          // must catch by comparing against the visible (post-nesting) order.
          type: "autonomous_resume",
          blockId: "resume-1",
          status: "completed",
          timestamp: 2003,
          triggers: [
            {
              kind: "subagent",
              title: "Investigate lifecycle",
              status: "completed",
              summary: "Subagent finished",
              blockId: "agent-1",
              outputFile: null,
            },
          ],
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current[0]?.segments.map((segment) => segment.kind)).toEqual([
      "subagent",
    ]);
  });

  it("drops prompt-less subagent blocks from background command tasks", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "Explore Sentry structure",
          task: "Explore Sentry usage across the repo.",
          progressUpdates: ["Reading sentry.ts"],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "background-command-1",
          name: 'find /repo -name "*sentry*"',
          task: null,
          progressUpdates: [],
          result: 'find /repo -name "*sentry*"',
          status: "completed",
          timestamp: 2002,
          startedAt: 2002,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const subagents =
      result.current[0]?.segments.filter(
        (segment) => segment.kind === "subagent",
      ) ?? [];

    expect(subagents).toHaveLength(1);
    expect(subagents[0]?.id).toBe("agent-1");
  });

  it("suppresses the spawn tool_call row in favor of the sub-agent card", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "toolu_1",
          toolName: "Agent",
          ...toolCallInputFields("Agent", {
            description: "Codex app-server lifecycle in host",
            prompt: "Investigate the lifecycle.",
          }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          endedAt: null,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "Codex app-server lifecycle in host",
          task: "Investigate the lifecycle.",
          progressUpdates: ["Running find ..."],
          result: null,
          status: "streaming",
          timestamp: 2002,
          startedAt: 2001,
          spawnToolCallId: "toolu_1",
          stopped: false,
          workflowMeta: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    // The duplicate spawn tool row is dropped (parity with file-edit tool calls).
    expect(
      segments.some(
        (segment) => segment.kind === "tool" && segment.id === "toolu_1",
      ),
    ).toBe(false);
    // The card remains as the sole representation, carrying the timer anchor.
    const subagent = segments.find((segment) => segment.kind === "subagent");
    expect(subagent?.id).toBe("agent-1");
  });

  it("computes subagent durationMs only for completed blocks, not interrupted ones", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-done",
          name: "done",
          task: "Investigate.",
          progressUpdates: [],
          result: "ok",
          status: "completed",
          timestamp: 5000,
          startedAt: 2000,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-interrupted",
          name: "interrupted",
          task: "Investigate.",
          progressUpdates: [],
          result: null,
          status: "interrupted",
          timestamp: 9000,
          startedAt: 2000,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const subagents = (result.current[0]?.segments ?? []).filter(
      (segment): segment is SubagentSegment => segment.kind === "subagent",
    );
    const done = subagents.find((segment) => segment.id === "agent-done");
    const interrupted = subagents.find(
      (segment) => segment.id === "agent-interrupted",
    );
    // Completed: spawn -> completion total.
    expect(done?.durationMs).toBe(3000);
    // Interrupted: `timestamp` is the turn-end, not the real finish, so the
    // builder leaves durationMs null (the end-state badge conveys the outcome).
    expect(interrupted?.durationMs).toBeNull();
  });

  it("computes background tool durationMs only from explicit start and end", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "background-done",
          status: "completed",
          timestamp: 6_000,
          toolName: "Bash",
          ...toolCallInputFields("Bash", {
            command: "sleep 60",
            run_in_background: true,
          }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: { stdout: "", stderr: "", truncated: false },
          backgroundTask: true,
          stopped: false,
          startedAt: 5_000,
          endedAt: 70_000,
        },
        {
          type: "tool_call",
          blockId: "background-old",
          status: "completed",
          timestamp: 5000,
          toolName: "Bash",
          ...toolCallInputFields("Bash", {
            command: "true",
            run_in_background: true,
          }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: { stdout: "", stderr: "", truncated: false },
          backgroundTask: true,
          stopped: false,
          startedAt: null,
          endedAt: 70_000,
        },
        {
          type: "tool_call",
          blockId: "background-stopped",
          status: "errored",
          timestamp: 70_000,
          toolName: "Bash",
          ...toolCallInputFields("Bash", {
            command: "sleep 60",
            run_in_background: true,
          }),
          error: "stopped: user requested stop",
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: true,
          // Modeling a block persisted before `stopped` existed - the legacy
          // string-prefix error is the only signal, parsed false per the
          // schema default. Exercises the GUI's fallback sniff.
          stopped: false,
          startedAt: 5_000,
          endedAt: 70_000,
        },
        {
          type: "tool_call",
          blockId: "background-failed",
          status: "errored",
          timestamp: 67_000,
          toolName: "Bash",
          ...toolCallInputFields("Bash", {
            command: "sleep 60",
            run_in_background: true,
          }),
          error: "failed: command exited with code 1",
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: true,
          stopped: false,
          startedAt: 5_000,
          endedAt: 67_000,
        },
        {
          type: "tool_call",
          blockId: "regular-tool",
          status: "completed",
          timestamp: 5000,
          toolName: "Bash",
          ...toolCallInputFields("Bash", { command: "pwd" }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          startedAt: 2000,
          endedAt: 5000,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const tools = (result.current[0]?.segments ?? []).filter(
      (segment): segment is ToolSegment => segment.kind === "tool",
    );
    const backgroundDone = tools.find(
      (segment) => segment.id === "background-done",
    );
    const backgroundOld = tools.find(
      (segment) => segment.id === "background-old",
    );
    const backgroundStopped = tools.find(
      (segment) => segment.id === "background-stopped",
    );
    const backgroundFailed = tools.find(
      (segment) => segment.id === "background-failed",
    );
    const regularTool = tools.find((segment) => segment.id === "regular-tool");

    expect(backgroundDone?.startedAt).toBe(5_000);
    expect(backgroundDone?.durationMs).toBe(65_000);
    expect(backgroundOld?.durationMs).toBeNull();
    expect(backgroundStopped?.durationMs).toBe(65_000);
    expect(backgroundFailed?.durationMs).toBe(62_000);
    expect(regularTool?.durationMs).toBeNull();
  });

  it("nests a subagent's command under its block via parentBlockId", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "explorer",
          task: "Investigate the bug.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "command",
          blockId: "command-1",
          command: "rg TODO",
          cwd: "/repo",
          exitCode: 0,
          status: "completed",
          timestamp: 2002,
          parentBlockId: "agent-1",
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const top = result.current[0]?.segments ?? [];
    // The command nests under the subagent rather than appearing top-level.
    expect(top.map((segment) => segment.kind)).toEqual(["subagent"]);
    const subagent = top[0];
    if (subagent.kind !== "subagent") {
      throw new Error("expected a subagent segment");
    }
    expect(subagent.children.map((child) => child.kind)).toEqual(["command"]);
    const child = subagent.children[0];
    if (child.kind !== "command") {
      throw new Error("expected a command child");
    }
    expect(child.command).toBe("rg TODO");
  });

  it("folds a depth-3 nested subagent chain via parentBlockId", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "root",
          task: "Plan the refactor.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-2",
          name: "mid",
          task: "Sweep call sites.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2002,
          startedAt: 2002,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
          parentBlockId: "agent-1",
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-3",
          name: "leaf",
          task: "Check fixtures.",
          progressUpdates: [],
          result: "All good.",
          status: "completed",
          timestamp: 2003,
          startedAt: 2003,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
          parentBlockId: "agent-2",
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const top = result.current[0]?.segments ?? [];
    expect(top.map((segment) => segment.kind)).toEqual(["subagent"]);
    const root = top[0];
    if (root.kind !== "subagent") {
      throw new Error("expected a subagent segment");
    }
    expect(root.id).toBe("agent-1");
    expect(root.children.map((child) => child.id)).toEqual(["agent-2"]);
    const mid = root.children[0];
    if (mid.kind !== "subagent") {
      throw new Error("expected a nested subagent segment");
    }
    expect(mid.children.map((child) => child.id)).toEqual(["agent-3"]);
    const leaf = mid.children[0];
    if (leaf.kind !== "subagent") {
      throw new Error("expected a nested subagent segment");
    }
    expect(leaf.result).toBe("All good.");
    expect(leaf.children).toEqual([]);
  });

  it("keeps a nested subagent top-level when its parentBlockId doesn't resolve", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "root",
          task: "Plan the refactor.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-orphan",
          name: "orphan",
          task: "Investigate stray work.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2002,
          startedAt: 2002,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
          // References a parent id never present in this turn's blocks (the
          // owning subagent.started was dropped/never arrived) - the fallback
          // is honest top-level placement, never vanishing or misattaching.
          parentBlockId: "agent-missing",
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const top = result.current[0]?.segments ?? [];
    expect(top.map((segment) => segment.kind)).toEqual([
      "subagent",
      "subagent",
    ]);
    expect(top.map((segment) => segment.id)).toEqual([
      "agent-1",
      "agent-orphan",
    ]);
    const root = top[0];
    if (root.kind !== "subagent") {
      throw new Error("expected a subagent segment");
    }
    expect(root.children).toEqual([]);
  });

  it("nests a subagent's provider notice under its block via parentBlockId", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "explorer",
          task: "Investigate the bug.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "text",
          blockId: "notice-1",
          text: "Codex switched from gpt-5 to gpt-5-safe.",
          status: "completed",
          timestamp: 2002,
          parentBlockId: "agent-1",
          providerNotice: {
            harnessId: "codex",
            noticeKind: "model_rerouted",
            tone: "warning",
            title: "Model changed",
            message: "Codex switched from gpt-5 to gpt-5-safe.",
            details: [{ label: "Reason", value: "highRiskCyberActivity" }],
            metadata: {
              type: "model_rerouted",
              fromModel: "gpt-5",
              toModel: "gpt-5-safe",
              reason: "highRiskCyberActivity",
            },
          },
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const top = result.current[0]?.segments ?? [];
    // The notice nests under the subagent rather than appearing top-level.
    expect(top.map((segment) => segment.kind)).toEqual(["subagent"]);
    const subagent = top[0];
    if (subagent.kind !== "subagent") {
      throw new Error("expected a subagent segment");
    }
    expect(subagent.children.map((child) => child.kind)).toEqual([
      "provider_notice",
    ]);
    const child = subagent.children[0];
    if (child.kind !== "provider_notice") {
      throw new Error("expected a provider_notice child");
    }
    expect(child.title).toBe("Model changed");
    expect(child.parentId).toBe("agent-1");
  });

  it("keeps a provider notice top-level when its parentBlockId doesn't resolve to a known subagent", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "text",
          blockId: "notice-orphan",
          text: "Codex switched from gpt-5 to gpt-5-safe.",
          status: "completed",
          timestamp: 2001,
          // References a parent id never present in this turn's blocks (the
          // owning subagent.started was dropped/never arrived) - the fallback
          // is honest top-level placement, never vanishing.
          parentBlockId: "agent-missing",
          providerNotice: {
            harnessId: "codex",
            noticeKind: "model_rerouted",
            tone: "warning",
            title: "Model changed",
            message: "Codex switched from gpt-5 to gpt-5-safe.",
            details: [],
            metadata: null,
          },
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const top = result.current[0]?.segments ?? [];
    expect(top.map((segment) => segment.kind)).toEqual(["provider_notice"]);
    const notice = top[0];
    if (notice.kind !== "provider_notice") {
      throw new Error("expected a top-level provider_notice segment");
    }
    expect(notice.parentId).toBe("agent-missing");
  });

  it("keeps a nested child attached across a parent name re-emit", () => {
    // `timestamp` must advance with the rename, exactly as a real host re-emit
    // always bumps it - otherwise the per-turn render cache (keyed on each
    // block's blockId/type/status/timestamp) reuses the stale model and the
    // test would pass or fail for the wrong reason.
    const buildAssistant = (
      parentName: string,
      timestamp: number,
    ): Message => ({
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: parentName,
          task: "Plan the refactor.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-2",
          name: "child",
          task: "Sweep call sites.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2002,
          startedAt: 2002,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
          parentBlockId: "agent-1",
        },
      ],
    });
    const inputFor = (
      parentName: string,
      timestamp: number,
    ): RenderedMessagesInput => ({
      messages: [buildAssistant(parentName, timestamp)],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      ...BINDING,
    });

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: inputFor("root", 2001) } },
    );

    const before = result.current[0]?.segments ?? [];
    expect(before.map((segment) => segment.kind)).toEqual(["subagent"]);

    rerender({ value: inputFor("root (renamed)", 2005) });

    const after = result.current[0]?.segments ?? [];
    expect(after.map((segment) => segment.kind)).toEqual(["subagent"]);
    const root = after[0];
    if (root.kind !== "subagent") {
      throw new Error("expected a subagent segment");
    }
    expect(root.name).toBe("root (renamed)");
    expect(root.children.map((child) => child.id)).toEqual(["agent-2"]);
  });

  it("builds the workflow card model from a workflowMeta-bearing subagent block, suppressing its spawn tool row", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "toolu_workflow",
          toolName: "Workflow",
          ...toolCallInputFields("Workflow", { script: "..." }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "completed",
          timestamp: 2000,
          startedAt: 2000,
          endedAt: 2000,
        },
        {
          type: "subagent",
          agentType: null,
          blockId: "workflow-1",
          name: "max-effort-review",
          task: "Max-effort review of the refusal-handling changeset",
          progressUpdates: ["Phase: Find", "find:host-core"],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: "toolu_workflow",
          stopped: false,
          workflowMeta: {
            name: "max-effort-review",
            intent: "Max-effort review of the refusal-handling changeset",
            activity: [
              { kind: "phase", text: "Phase — Find (16 agents)" },
              { kind: "label", text: "find:host-core" },
            ],
            agentsStarted: 16,
            agentsFinished: 3,
            totalTokens: 412_000,
          },
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    const workflow = segments.find((segment) => segment.kind === "subagent");
    if (workflow === undefined) {
      throw new Error("expected a subagent segment");
    }
    expect(workflow.workflowMeta).not.toBeNull();
    expect(workflow.workflowMeta?.agentsStarted).toBe(16);
    expect(workflow.workflowMeta?.agentsFinished).toBe(3);
    expect(workflow.workflowMeta?.totalTokens).toBe(412_000);
    expect(workflow.workflowMeta?.activity).toEqual([
      { kind: "phase", text: "Phase — Find (16 agents)" },
      { kind: "label", text: "find:host-core" },
    ]);
    // The spawning Workflow tool call is suppressed via spawnToolCallId - the
    // same policy the plain subagent card already uses.
    expect(
      segments.some(
        (segment) => segment.kind === "tool" && segment.id === "toolu_workflow",
      ),
    ).toBe(false);
  });

  it("leaves a plain subagent block's workflowMeta null", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "subagent",
          agentType: null,
          blockId: "agent-1",
          name: "explorer",
          task: "Investigate the bug.",
          progressUpdates: [],
          result: null,
          status: "streaming",
          timestamp: 2001,
          startedAt: 2001,
          spawnToolCallId: null,
          stopped: false,
          workflowMeta: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segment = (result.current[0]?.segments ?? []).find(
      (candidate) => candidate.kind === "subagent",
    );
    if (segment === undefined) {
      throw new Error("expected a subagent segment");
    }
    expect(segment.workflowMeta).toBeNull();
  });

  it("drops the live assistant when the persisted assistant for the same turn exists", () => {
    const a = assistantMessage("turn-1", 2000);
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [a],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: {
            turnId: "turn-1",
            blocks: [],
            startedAt: 2500,
            blocksVersion: 0,
            timestamp: 2500,
            sender: ASSISTANT_SENDER,
            reasoningEffort: null,
            serviceTier: null,
          },
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.id).toBe("assistant:turn-1");
  });

  it("keeps persisted rows stable while only the live row streams", () => {
    const u1 = userMessage("m1");
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-1",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: "m1",
      startedAt: 1,
      updatedAt: 2,
      reasoningEffort: null,
      serviceTier: null,
    };
    const firstLive: RenderedMessagesInput = {
      messages: [u1],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: {
        turnId: "turn-1",
        blocks: [
          {
            type: "text",
            blockId: "text-1",
            text: "a",
            status: "streaming",
            timestamp: 10,
            providerNotice: null,
          },
        ],
        startedAt: 2000,
        blocksVersion: 1,
        timestamp: 2000,
        sender: ASSISTANT_SENDER,
        reasoningEffort: null,
        serviceTier: null,
      },
      activeTurn,
      runStatus: "running",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: firstLive } },
    );
    const firstUserRow = result.current.find(
      (message) => message.role === "user",
    );

    // A streamed delta: same `messages` reference, a brand-new live row object
    // with one more token. The live turn has no persisted assistant message, so
    // the persisted render must NOT re-derive - the user row keeps its identity.
    rerender({
      value: {
        ...firstLive,
        liveAssistantMessage: {
          turnId: "turn-1",
          blocks: [
            {
              type: "text",
              blockId: "text-1",
              text: "ab",
              status: "streaming",
              timestamp: 11,
              providerNotice: null,
            },
          ],
          startedAt: 2000,
          blocksVersion: 2,
          timestamp: 2001,
          sender: ASSISTANT_SENDER,
          reasoningEffort: null,
          serviceTier: null,
        },
      },
    });
    const secondUserRow = result.current.find(
      (message) => message.role === "user",
    );

    expect(secondUserRow).toBe(firstUserRow);
  });

  it("subtracts completed approval wait time from assistant turn accounting", () => {
    const assistant = {
      ...assistantMessage("turn-1", 10_000),
      timestamp: 40_000,
      blocks: [
        {
          type: "text" as const,
          blockId: "text-1",
          status: "completed" as const,
          timestamp: 40_000,
          text: "Done",
          providerNotice: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistant],
          events: [
            waitEvent({
              type: "approval.requested",
              timestamp: 15_000,
              turnId: "turn-1",
              approvalId: "approval-1",
              blockId: null,
            }),
            waitEvent({
              type: "approval.resolved",
              timestamp: 25_000,
              turnId: "turn-1",
              approvalId: "approval-1",
              blockId: null,
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const row = result.current.find((message) => message.role === "assistant");
    expect(row?.createdAt).toBe(10_000);
    expect(row?.completedAt).toBe(40_000);
    expect(row?.pausedDurationMs).toBe(10_000);
    expect(row?.pausedSinceMs).toBeNull();
  });

  it("subtracts completed interview wait time from assistant turn accounting", () => {
    const assistant = {
      ...assistantMessage("turn-1", 10_000),
      timestamp: 42_000,
      blocks: [
        {
          type: "text" as const,
          blockId: "text-1",
          status: "completed" as const,
          timestamp: 42_000,
          text: "Done",
          providerNotice: null,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistant],
          events: [
            waitEvent({
              type: "interview.requested",
              timestamp: 16_000,
              turnId: "turn-1",
              approvalId: null,
              blockId: "question-1",
            }),
            waitEvent({
              type: "interview.resolved",
              timestamp: 29_000,
              turnId: "turn-1",
              approvalId: null,
              blockId: "question-1",
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const row = result.current.find((message) => message.role === "assistant");
    expect(row?.createdAt).toBe(10_000);
    expect(row?.completedAt).toBe(42_000);
    expect(row?.pausedDurationMs).toBe(13_000);
    expect(row?.pausedSinceMs).toBeNull();
  });

  it("freezes the live assistant timer while an approval is pending", () => {
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-1",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: "m1",
      startedAt: 10_000,
      updatedAt: 20_000,
      reasoningEffort: null,
      serviceTier: null,
    };
    const liveAssistant: LiveAssistantMessage = {
      turnId: "turn-1",
      sender: ASSISTANT_SENDER,
      blocks: [],
      startedAt: 10_000,
      blocksVersion: 0,
      timestamp: 20_000,
      reasoningEffort: null,
      serviceTier: null,
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1")],
          events: [
            waitEvent({
              type: "approval.requested",
              timestamp: 15_000,
              turnId: "turn-1",
              approvalId: "approval-1",
              blockId: null,
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: liveAssistant,
          activeTurn,
          pendingApprovals: [
            {
              approvalId: "approval-1",
              toolName: "Edit",
              description: "Apply edit",
              input: null,
              requestedAt: 15_000,
              kind: "tool",
              planId: null,
              actions: [],
            },
          ],
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const row = result.current.find((message) => message.role === "assistant");
    expect(row?.pausedDurationMs).toBe(0);
    expect(row?.pausedSinceMs).toBe(15_000);
  });

  it("freezes the live assistant timer while an interview is pending from snapshot state", () => {
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-1",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: "m1",
      startedAt: 10_000,
      updatedAt: 20_000,
      reasoningEffort: null,
      serviceTier: null,
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1")],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: {
            turnId: "turn-1",
            sender: ASSISTANT_SENDER,
            blocks: [],
            startedAt: 10_000,
            blocksVersion: 0,
            timestamp: 20_000,
            reasoningEffort: null,
            serviceTier: null,
          },
          activeTurn,
          pendingInterviews: [{ blockId: "question-1", requestedAt: 16_000 }],
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const row = result.current.find((message) => message.role === "assistant");
    expect(row?.pausedDurationMs).toBe(0);
    expect(row?.pausedSinceMs).toBe(16_000);
  });

  it("keeps the assistant row id stable from live turn to completion", () => {
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-1",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: null,
      startedAt: 1,
      updatedAt: 2,
      reasoningEffort: null,
      serviceTier: null,
    };
    const liveInput: RenderedMessagesInput = {
      messages: [userMessage("m1")],
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: {
        turnId: "turn-1",
        blocks: [],
        startedAt: 2000,
        blocksVersion: 0,
        timestamp: 2000,
        sender: ASSISTANT_SENDER,
        reasoningEffort: null,
        serviceTier: null,
      },
      activeTurn,
      runStatus: "running",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: liveInput } },
    );
    const liveAssistantId = result.current.find(
      (message) => message.role === "assistant",
    )?.id;

    rerender({
      value: {
        ...liveInput,
        messages: [userMessage("m1"), assistantMessage("turn-1", 2000)],
        liveAssistantMessage: null,
        activeTurn: null,
        runStatus: "idle",
      },
    });

    expect(liveAssistantId).toBe("assistant:turn-1");
    expect(
      result.current.find((message) => message.role === "assistant")?.id,
    ).toBe(liveAssistantId);
  });

  it("keeps an accepted pending user before the pre-turn assistant row", () => {
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-2",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: "m2",
      startedAt: 2500,
      updatedAt: 2500,
      reasoningEffort: null,
      serviceTier: null,
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistantMessage("turn-1", 2000)],
          events: [],
          pendingUserMessages: [
            {
              clientActionId: "action-2",
              messageId: "m2",
              content: CONTENT,
              sender: { type: "user", userId: "owner-1" },
              settings: SETTINGS,
              timestamp: 3000,
            },
          ],
          liveAssistantMessage: null,
          activeTurn,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current.map((message) => message.id)).toEqual([
      "m1",
      "assistant:turn-1",
      "m2",
      "assistant:turn-2",
    ]);
  });

  it("attaches checkpoint manifests to file change groups by assistant turn id", () => {
    const manifest = checkpointManifest("turn-1", "/repo/src/app.ts");
    const laterManifest = checkpointManifest("turn-2", "/repo/src/app.ts");
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "file_change",
          blockId: "file-1",
          filePath: "/repo/src/app.ts",
          operation: "edit",
          diffSource: "snapshot",
          beforeHash: "a".repeat(64),
          afterHash: "b".repeat(64),
          additions: 1,
          deletions: 1,
          reason: "snapshot",
          status: "completed",
          timestamp: 2001,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [checkpointEvent(manifest), checkpointEvent(laterManifest)],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // The aggregate file_change_group is appended at the END of the
    // assistant message; inline file_change segments stay flat in their
    // conversational position for display-time grouping.
    const segments = result.current[0]?.segments ?? [];
    const group = segments[segments.length - 1];

    expect(group.kind).toBe("file_change_group");
    if (group.kind !== "file_change_group") {
      throw new Error("expected file change group");
    }
    expect(group.checkpointManifest?.checkpointId).toBe("turn-1");
    expect(group.hasLaterOverlappingChanges).toBe(true);
  });

  it("detects a later overlapping change across an intervening unrelated turn", () => {
    // turn-1 edits app.ts, turn-2 edits an unrelated file, turn-3 edits app.ts
    // again. The overlap for turn-1 is non-adjacent (it is separated from the
    // later touch by turn-2), so the warning must still surface.
    const manifest = checkpointManifest("turn-1", "/repo/src/app.ts");
    const unrelatedManifest = checkpointManifest(
      "turn-2",
      "/repo/src/other.ts",
    );
    const laterManifest = checkpointManifest("turn-3", "/repo/src/app.ts");
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [fileChangeBlock("/repo/src/app.ts")],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [
            checkpointEvent(manifest),
            checkpointEvent(unrelatedManifest),
            checkpointEvent(laterManifest),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    const group = segments[segments.length - 1];

    expect(group.kind).toBe("file_change_group");
    if (group.kind !== "file_change_group") {
      throw new Error("expected file change group");
    }
    expect(group.checkpointManifest?.checkpointId).toBe("turn-1");
    expect(group.hasLaterOverlappingChanges).toBe(true);
  });

  it("holds back the file change group until the assistant turn completes", () => {
    const manifest = checkpointManifest("turn-1", "/repo/src/app.ts");
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [fileChangeBlock("/repo/src/app.ts")],
    };
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-1",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: null,
      startedAt: 1,
      updatedAt: 2,
      reasoningEffort: null,
      serviceTier: null,
    };
    const baseInput: RenderedMessagesInput = {
      messages: [assistant],
      events: [checkpointEvent(manifest)],
      pendingUserMessages: [],
      liveAssistantMessage: null,
      activeTurn,
      runStatus: "running",
      ...BINDING,
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: RenderedMessagesInput }) =>
        useRenderedMessages(value, displayContext),
      { initialProps: { value: baseInput } },
    );
    const activeSegments = result.current[0]?.segments ?? [];
    expect(
      activeSegments.some((segment) => segment.kind === "file_change_group"),
    ).toBe(false);
    // The inline file edit still shows while the turn streams.
    expect(
      activeSegments.some((segment) => segment.kind === "file_change"),
    ).toBe(true);

    rerender({
      value: { ...baseInput, activeTurn: null, runStatus: "idle" },
    });
    const doneSegments = result.current[0]?.segments ?? [];
    expect(
      doneSegments.some((segment) => segment.kind === "file_change_group"),
    ).toBe(true);
  });

  it("shows a successful edit inline and in the group (tool suppressed)", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "edit-2",
          toolName: "edit",
          ...toolCallInputFields("edit", { file_path: "/repo/src/app.ts" }),
          error: null,
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "completed",
          timestamp: 2001,
          startedAt: 2001,
          endedAt: 2001,
        },
        {
          type: "file_change",
          blockId: "edit-2:file-edit:file-change:0",
          filePath: "/repo/src/app.ts",
          operation: "edit",
          diffSource: "snapshot",
          beforeHash: "a".repeat(64),
          afterHash: "b".repeat(64),
          additions: 1,
          deletions: 1,
          reason: "snapshot",
          status: "completed",
          timestamp: 2002,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    // The edit's tool_call is suppressed; the file_change shows inline (the
    // edit activity) and the aggregated group is appended at completion.
    expect(segments.some((segment) => segment.kind === "tool")).toBe(false);
    expect(segments.some((segment) => segment.kind === "file_change")).toBe(
      true,
    );
    expect(
      segments.some((segment) => segment.kind === "file_change_group"),
    ).toBe(true);
  });

  it("keeps a denied edit inline as a file change (tool suppressed, no group)", () => {
    const assistant: Message = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        {
          type: "tool_call",
          blockId: "edit-1",
          toolName: "edit",
          ...toolCallInputFields("edit", { file_path: "/repo/src/app.ts" }),
          error: "Permission denied by user",
          agentMessageSend: null,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          stopped: false,
          status: "errored",
          timestamp: 2001,
          startedAt: 2001,
          endedAt: 2001,
        },
        {
          type: "file_change",
          blockId: "edit-1:file-edit:file-change:0",
          filePath: "/repo/src/app.ts",
          operation: "edit",
          diffSource: "none",
          beforeHash: null,
          afterHash: null,
          additions: 0,
          deletions: 0,
          reason: "denied",
          status: "completed",
          timestamp: 2002,
        },
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [assistant],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const segments = result.current[0]?.segments ?? [];
    // Redundant Edit tool_call is suppressed; the denied edit stays inline as a
    // file_change (with status) and is never grouped as a "change".
    expect(segments.some((segment) => segment.kind === "tool")).toBe(false);
    expect(segments.some((segment) => segment.kind === "file_change")).toBe(
      true,
    );
    expect(
      segments.some((segment) => segment.kind === "file_change_group"),
    ).toBe(false);
  });

  it("keeps a streaming file change before it completes", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: {
            turnId: "turn-1",
            blocks: [
              {
                type: "file_change",
                blockId: "file-streaming",
                filePath: "/repo/src/app.ts",
                operation: "edit",
                diffSource: "none",
                beforeHash: null,
                afterHash: null,
                additions: 0,
                deletions: 0,
                reason: "capture_failed",
                status: "streaming",
                timestamp: 2001,
              },
            ],
            startedAt: 1,
            blocksVersion: 1,
            timestamp: 2001,
            sender: ASSISTANT_SENDER,
            reasoningEffort: null,
            serviceTier: null,
          },
          activeTurn: {
            turnId: "turn-1",
            status: "running",
            harnessId: "claude",
            model: "claude-sonnet-4-5",
            agentMode: "regular",
            profileId: null,
            userMessageId: null,
            startedAt: 1,
            updatedAt: 2,
            reasoningEffort: null,
            serviceTier: null,
          },
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );
    const segments = result.current[0]?.segments ?? [];
    expect(segments.some((segment) => segment.kind === "file_change")).toBe(
      true,
    );
  });

  it("holds back the file change group for the streaming live assistant", () => {
    const activeTurn: ChatActiveTurn = {
      turnId: "turn-1",
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      agentMode: "regular",
      profileId: null,
      userMessageId: null,
      startedAt: 1,
      updatedAt: 2,
      reasoningEffort: null,
      serviceTier: null,
    };
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: {
            turnId: "turn-1",
            blocks: [fileChangeBlock("/repo/src/app.ts")],
            startedAt: 2500,
            blocksVersion: 1,
            timestamp: 2500,
            sender: ASSISTANT_SENDER,
            reasoningEffort: null,
            serviceTier: null,
          },
          activeTurn,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );
    const segments = result.current[0]?.segments ?? [];
    expect(
      segments.some((segment) => segment.kind === "file_change_group"),
    ).toBe(false);
    expect(segments.some((segment) => segment.kind === "file_change")).toBe(
      true,
    );
  });
});

function setupEvent(input: {
  readonly eventId: string;
  readonly type: Extract<
    ChatEvent["type"],
    | "setup.creating"
    | "setup.running"
    | "setup.succeeded"
    | "setup.failed"
    | "setup.cancelled"
    | "worktree.missing"
  >;
  readonly timestamp: number;
  readonly metadata: Record<string, unknown>;
}): ChatEvent {
  return {
    eventId: input.eventId,
    type: input.type,
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: input.metadata,
  };
}

function forkEvent(input: {
  readonly eventId: string;
  readonly timestamp: number;
  readonly metadata: Record<string, unknown>;
}): ChatEvent {
  const assistantTurnKey = input.metadata["assistantTurnKey"];
  return {
    eventId: input.eventId,
    type: "chat.forked",
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: typeof assistantTurnKey === "string" ? assistantTurnKey : null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: input.metadata,
  };
}

const RUNNING_ACTIVE_TURN: ChatActiveTurn = {
  turnId: "turn-setup",
  status: "running",
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  agentMode: "regular",
  profileId: null,
  userMessageId: null,
  startedAt: 1,
  updatedAt: 2,
  reasoningEffort: null,
  serviceTier: null,
};

describe("useRenderedMessages fork link integration", () => {
  it("projects chat.forked events into fork-source link rows", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistantMessage("turn-1", 2000)],
          events: [
            forkEvent({
              eventId: "fork-1",
              timestamp: 2500,
              metadata: {
                sourceChatId: "source-chat-1",
                sourceChatTitle: "Original chat",
                sourceHostId: "source-host-1",
                assistantTurnKey: "turn-1",
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current.map((message) => message.id)).toEqual([
      "m1",
      "assistant:turn-1",
      "forked-chat-link:fork-1",
    ]);
    const forkRow = result.current[2];
    expect(forkRow.role).toBe("system");
    expect(forkRow.createdAt).toBe(2500);
    const segment = forkRow.segments[0];
    expect(segment.kind).toBe("forked-chat-link");
    if (segment.kind !== "forked-chat-link") {
      throw new Error("expected forked-chat-link");
    }
    expect(segment.sourceChatId).toBe("source-chat-1");
    expect(segment.sourceChatTitle).toBe("Original chat");
    expect(segment.sourceHostId).toBe("source-host-1");
    expect(segment.viewTabId).toBe("tab-1");
  });

  it("skips malformed chat.forked metadata", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1")],
          events: [
            forkEvent({
              eventId: "fork-bad",
              timestamp: 2500,
              // Missing sourceChatId — required field absent → row skipped
              metadata: {
                sourceChatTitle: "Some chat",
                sourceHostId: "source-host-1",
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current.map((message) => message.id)).toEqual(["m1"]);
  });
});

describe("useRenderedMessages setup card integration", () => {
  it("pins the genesis setup card above the first user message", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1")],
          events: [
            setupEvent({
              eventId: "s-running",
              type: "setup.running",
              timestamp: 1500,
              metadata: { workspacePath: "/repo", terminalSessionId: "term-1" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // The genesis card is PINNED first - above the first user message (m1,
    // createdAt 1002) - regardless of its (late) genesis timestamp (1500). The
    // id carries the window ordinal (0) before the genesis so two windows can
    // never collide on the React/virtualizer key.
    expect(result.current.map((message) => message.id)).toEqual([
      "setup-card:owner-1:0:1500",
      "m1",
    ]);
    const card = result.current[0];
    expect(card.role).toBe("system");
    expect(card.createdAt).toBe(1500);
    expect(card.segments).toHaveLength(1);
    const segment = card.segments[0];
    expect(segment.kind).toBe("setup-card");
    if (segment.kind !== "setup-card") throw new Error("expected setup-card");
    expect(segment.viewTabId).toBe("tab-1");
    expect(segment.model.aggregate.state).toBe("setting-up");
    expect(segment.model.aggregate.ownerId).toBe("owner-1");
  });

  it("pins only the genesis card; a re-bind window stays inline at its timestamp", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistantMessage("turn-1", 2000)],
          events: [
            setupEvent({
              eventId: "g-running",
              type: "setup.running",
              timestamp: 1500,
              metadata: { workspacePath: "/repo", terminalSessionId: "term-1" },
            }),
            setupEvent({
              eventId: "g-succeeded",
              type: "setup.succeeded",
              timestamp: 1600,
              metadata: { workspacePath: "/repo" },
            }),
            setupEvent({
              eventId: "rebind-missing",
              type: "worktree.missing",
              timestamp: 2100,
              metadata: { workspacePath: "/repo", priorWorktreePath: "/repo" },
            }),
            setupEvent({
              eventId: "rebind-running",
              type: "setup.running",
              timestamp: 2200,
              metadata: { workspacePath: "/repo", terminalSessionId: "term-2" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // Genesis (window 0, ts 1500) is pinned to the very top; the re-bind window
    // (window 1, ts 2200) interleaves inline AFTER the assistant turn (2000).
    expect(result.current.map((message) => message.id)).toEqual([
      "setup-card:owner-1:0:1500",
      "m1",
      "assistant:turn-1",
      "setup-card:owner-1:1:2200",
    ]);
  });

  it("anchors a mid-chat FIRST creation above its triggering send (window 0 not pinned)", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          // The chat's FIRST worktree is created mid-conversation by the `create`
          // send. Window 0 carries a `setup.creating` (so it is NOT a back-filled
          // genesis and must NOT pin to the top), and that event stamps
          // `triggeringMessageId`, so the card anchors directly above the send -
          // exactly the production shape (the host always stamps the id).
          messages: [
            userMessage("m1"),
            assistantMessage("turn-1", 2000),
            userMessageAt("create", 2400),
          ],
          events: [
            setupEvent({
              eventId: "midchat-creating",
              type: "setup.creating",
              timestamp: 2500,
              metadata: {
                workspacePath: "/repo",
                branch: "feature",
                triggeringMessageId: "create",
              },
            }),
            setupEvent({
              eventId: "midchat-running",
              type: "setup.running",
              timestamp: 2600,
              metadata: { workspacePath: "/repo", terminalSessionId: "term-1" },
            }),
            setupEvent({
              eventId: "midchat-succeeded",
              type: "setup.succeeded",
              timestamp: 2700,
              metadata: { workspacePath: "/repo" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // Card sits immediately above its `create` send: NOT pinned above m1, and not
    // floated to its own 2500 stamp BELOW the send (which a createdAt sort gives).
    expect(result.current.map((message) => message.id)).toEqual([
      "m1",
      "assistant:turn-1",
      "setup-card:owner-1:0:2500",
      "create",
    ]);
  });

  it("pins the genesis but anchors a later different-repo creation above its send", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [
            userMessage("m1"),
            assistantMessage("turn-1", 2000),
            userMessageAt("create-other", 2400),
          ],
          events: [
            // Genesis worktree (window 0): back-filled, NO creating phase -> pins.
            setupEvent({
              eventId: "g-running",
              type: "setup.running",
              timestamp: 1500,
              metadata: { workspacePath: "/repo", terminalSessionId: "term-1" },
            }),
            setupEvent({
              eventId: "g-succeeded",
              type: "setup.succeeded",
              timestamp: 1600,
              metadata: { workspacePath: "/repo" },
            }),
            // A SEPARATE later send (`create-other`) creates a worktree for a
            // DIFFERENT repo. Its `setup.creating` splits a fresh window (the
            // genesis already progressed past creating) and stamps
            // `triggeringMessageId`, so the window anchors above that send.
            setupEvent({
              eventId: "midchat-creating",
              type: "setup.creating",
              timestamp: 2500,
              metadata: {
                workspacePath: "/other",
                branch: "feature",
                triggeringMessageId: "create-other",
              },
            }),
            setupEvent({
              eventId: "midchat-running",
              type: "setup.running",
              timestamp: 2600,
              metadata: {
                workspacePath: "/other",
                terminalSessionId: "term-2",
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // Genesis (window 0) pinned at the very top; the different-repo creation
    // (window 1) anchors directly ABOVE its `create-other` send - NOT folded into
    // the genesis card, NOT moved to the top, NOT floated below the send.
    expect(result.current.map((message) => message.id)).toEqual([
      "setup-card:owner-1:0:1500",
      "m1",
      "assistant:turn-1",
      "setup-card:owner-1:1:2500",
      "create-other",
    ]);
  });

  it("anchors a mid-chat card directly above its triggering message, overriding createdAt", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [
            userMessage("m0"),
            userMessage("trigger-msg"),
            assistantMessage("turn-1", 6000),
          ],
          events: [
            // The card is announced (`setup.creating`) BEFORE the slow git
            // worktree add, but its server `createdAt` (5000) lands AFTER the
            // triggering message's stamp (1011) - the clock-skew / persisted-
            // later case. A pure createdAt sort would drop the card BELOW
            // `trigger-msg`; the messageId anchor keeps it directly ABOVE.
            setupEvent({
              eventId: "creating",
              type: "setup.creating",
              timestamp: 5000,
              metadata: {
                workspacePath: "/repo",
                branch: "feat",
                triggeringMessageId: "trigger-msg",
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // Card sits immediately above `trigger-msg` (not floated to its 5000 stamp
    // between the message and the assistant turn, and not pinned to the top).
    expect(result.current.map((message) => message.id)).toEqual([
      "m0",
      "setup-card:owner-1:0:5000",
      "trigger-msg",
      "assistant:turn-1",
    ]);
  });

  it("anchors the card above the optimistic pending echo before the message persists", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          // The persisted message hasn't arrived (git worktree add still
          // running); only the optimistic echo exists. The card must still sit
          // directly above it so "Creating worktree" shows above the just-sent
          // message INSTANTLY - the whole point of restoring the echo.
          messages: [userMessage("m0")],
          events: [
            setupEvent({
              eventId: "creating",
              type: "setup.creating",
              timestamp: 5000,
              metadata: {
                workspacePath: "/repo",
                branch: "feat",
                triggeringMessageId: "echo-msg",
              },
            }),
          ],
          pendingUserMessages: [
            {
              clientActionId: "action-1",
              messageId: "echo-msg",
              content: CONTENT,
              sender: { type: "user", userId: "owner-1" },
              settings: SETTINGS,
              timestamp: 1010,
            },
          ],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    expect(result.current.map((message) => message.id)).toEqual([
      "m0",
      "setup-card:owner-1:0:5000",
      "echo-msg",
    ]);
  });

  it("drops a pending user echo whose messageId is already persisted", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1")],
          events: [],
          // The optimistic echo for m1 lingers (orphaned) after m1 persisted -
          // the setup-gating race. It must NOT render a second m1 row.
          pendingUserMessages: [
            {
              clientActionId: "action-1",
              messageId: "m1",
              content: CONTENT,
              sender: { type: "user", userId: "owner-1" },
              settings: SETTINGS,
              timestamp: 3000,
            },
          ],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const m1Rows = result.current.filter((message) => message.id === "m1");
    expect(m1Rows).toHaveLength(1);
    // The persisted row wins (real send metadata, statusLabel null), not the
    // pending echo (statusLabel "Pending").
    expect(m1Rows[0].statusLabel).toBeNull();
  });

  it("emits one card per setup lifecycle window anchored at each genesis", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "s1-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repo", terminalSessionId: "term-1" },
            }),
            setupEvent({
              eventId: "s1-succeeded",
              type: "setup.succeeded",
              timestamp: 1100,
              metadata: { workspacePath: "/repo" },
            }),
            setupEvent({
              eventId: "missing",
              type: "worktree.missing",
              timestamp: 1200,
              metadata: { workspacePath: "/repo", priorWorktreePath: "/repo" },
            }),
            setupEvent({
              eventId: "s2-running",
              type: "setup.running",
              timestamp: 1300,
              metadata: {
                workspacePath: "/repo2",
                terminalSessionId: "term-2",
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const cards = result.current.filter((message) =>
      message.id.startsWith("setup-card:"),
    );
    expect(cards.map((card) => card.createdAt)).toEqual([1000, 1300]);
    const states = cards.map((card) => {
      const segment = card.segments[0];
      if (segment.kind !== "setup-card") {
        throw new Error("expected setup-card");
      }
      return segment.model.aggregate.state;
    });
    // The first window stays `ready`; the re-bind opens a fresh `setting-up`
    // card rather than flipping the old one back.
    expect(states).toEqual(["ready", "setting-up"]);
  });

  it("consolidates a multi-repo window into one card with per-workspace state", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "a-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repoA", terminalSessionId: "ta" },
            }),
            setupEvent({
              eventId: "b-running",
              type: "setup.running",
              timestamp: 1010,
              metadata: { workspacePath: "/repoB", terminalSessionId: "tb" },
            }),
            setupEvent({
              eventId: "a-succeeded",
              type: "setup.succeeded",
              timestamp: 1100,
              metadata: { workspacePath: "/repoA" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const cards = result.current.filter((message) =>
      message.id.startsWith("setup-card:"),
    );
    expect(cards).toHaveLength(1);
    const segment = cards[0].segments[0];
    if (segment.kind !== "setup-card") throw new Error("expected setup-card");
    expect(segment.model.workspaces.map((w) => w.state)).toEqual([
      "ready",
      "setting-up",
    ]);
    // One still in flight ⇒ the rollup keeps the consolidated card active.
    expect(segment.model.aggregate.state).toBe("setting-up");
  });

  it("surfaces failed and cancelled lifecycle state on the card model", () => {
    const failed = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "f-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repo", terminalSessionId: "tf" },
            }),
            setupEvent({
              eventId: "f-failed",
              type: "setup.failed",
              timestamp: 1100,
              metadata: {
                workspacePath: "/repo",
                terminalSessionId: "tf",
                setupExitCode: 7,
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    const failedCard = failed.result.current.find((message) =>
      message.id.startsWith("setup-card:"),
    );
    const failedSegment = failedCard?.segments[0];
    if (failedSegment?.kind !== "setup-card") {
      throw new Error("expected setup-card");
    }
    expect(failedSegment.model.aggregate.state).toBe("failed");
    // The failing workspace carries the exit code + terminal the card's Retry /
    // Open-terminal affordances key off.
    expect(failedSegment.model.workspaces[0]).toMatchObject({
      state: "failed",
      setupExitCode: 7,
      terminalSessionId: "tf",
    });

    const cancelled = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "c-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repo", terminalSessionId: "tc" },
            }),
            setupEvent({
              eventId: "c-cancelled",
              type: "setup.cancelled",
              timestamp: 1100,
              metadata: { workspacePath: "/repo", terminalSessionId: "tc" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );
    const cancelledCard = cancelled.result.current.find((message) =>
      message.id.startsWith("setup-card:"),
    );
    const cancelledSegment = cancelledCard?.segments[0];
    if (cancelledSegment?.kind !== "setup-card") {
      throw new Error("expected setup-card");
    }
    expect(cancelledSegment.model.aggregate.state).toBe("cancelled");
    expect(cancelledSegment.model.workspaces[0]?.terminalSessionId).toBe("tc");
  });

  it("suppresses the pre-turn Working indicator while setup gates", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "g-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repo", terminalSessionId: "tg" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: RUNNING_ACTIVE_TURN,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // The gating card stands in for the indicator: no synthetic assistant row.
    expect(result.current.some((message) => message.role === "assistant")).toBe(
      false,
    );
    const card = result.current.find((message) =>
      message.id.startsWith("setup-card:"),
    );
    const segment = card?.segments[0];
    if (segment?.kind !== "setup-card") throw new Error("expected setup-card");
    expect(segment.model.aggregate.state).toBe("setting-up");
  });

  it("still shows the pre-turn Working indicator for a normal turn (no active setup)", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: RUNNING_ACTIVE_TURN,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const indicator = result.current.find(
      (message) => message.role === "assistant",
    );
    expect(indicator?.runState).toBe("running");
    expect(indicator?.id).toBe("assistant:turn-setup");
  });

  it("still shows the Working indicator when setup has already completed", () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "done-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repo", terminalSessionId: "td" },
            }),
            setupEvent({
              eventId: "done-succeeded",
              type: "setup.succeeded",
              timestamp: 1100,
              metadata: { workspacePath: "/repo" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: RUNNING_ACTIVE_TURN,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // Setup is `ready`, not gating, so the awaited turn's indicator returns.
    expect(
      result.current.some(
        (message) =>
          message.role === "assistant" && message.runState === "running",
      ),
    ).toBe(true);
  });

  it("shows the pre-turn Working indicator when a running setup was reset by worktree.missing", () => {
    // Regression: a `setup.running` closed by `worktree.missing` (worktree
    // vanished mid-setup) strands a historical card at `setting-up`. Because the
    // window is closed it reads inactive, so it must NOT suppress the indicator
    // for a later normal turn - only the LIVE lifecycle gates.
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "stranded-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repo", terminalSessionId: "ts" },
            }),
            setupEvent({
              eventId: "stranded-missing",
              type: "worktree.missing",
              timestamp: 1100,
              metadata: { workspacePath: "/repo", priorWorktreePath: "/repo" },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: RUNNING_ACTIVE_TURN,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // The awaited turn's "Working…" indicator returns despite the stranded card.
    const indicator = result.current.find(
      (message) => message.role === "assistant",
    );
    expect(indicator?.runState).toBe("running");
    expect(indicator?.id).toBe("assistant:turn-setup");
    // And the stranded card stays in the transcript as a historical record.
    expect(
      result.current.some((message) => message.id.startsWith("setup-card:")),
    ).toBe(true);
  });

  it("suppresses the Working indicator while a multi-repo window has a failed and a still-setting-up repo", () => {
    // F3b regression: the rollup ranks `failed` above `setting-up`, so a
    // multi-repo window with one failed + one in-flight repo rolls up to
    // `failed`. Suppression must key off any-workspace-setting-up, NOT the
    // aggregate, so the live card still stands in for the awaited turn (no
    // duplicate "Working…" beside it).
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [],
          events: [
            setupEvent({
              eventId: "mr-a-running",
              type: "setup.running",
              timestamp: 1000,
              metadata: { workspacePath: "/repoA", terminalSessionId: "ta" },
            }),
            setupEvent({
              eventId: "mr-b-running",
              type: "setup.running",
              timestamp: 1010,
              metadata: { workspacePath: "/repoB", terminalSessionId: "tb" },
            }),
            setupEvent({
              eventId: "mr-a-failed",
              type: "setup.failed",
              timestamp: 1100,
              metadata: {
                workspacePath: "/repoA",
                setupExitCode: 1,
                terminalSessionId: "ta",
              },
            }),
          ],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: RUNNING_ACTIVE_TURN,
          runStatus: "running",
          ...BINDING,
        },
        displayContext,
      ),
    );

    // No synthetic assistant "Working…" row: the live card (still in flight via
    // /repoB) stands in for it, even though the aggregate rolled up to failed.
    expect(result.current.some((message) => message.role === "assistant")).toBe(
      false,
    );
    const card = result.current.find((message) =>
      message.id.startsWith("setup-card:"),
    );
    const segment = card?.segments[0];
    if (segment?.kind !== "setup-card") throw new Error("expected setup-card");
    expect(segment.model.aggregate.state).toBe("failed");
    expect(
      segment.model.workspaces.some(
        (workspace) => workspace.state === "setting-up",
      ),
    ).toBe(true);
  });
});

describe("useRenderedMessages head/tail partition", () => {
  function turnTextBlock(
    blockId: string,
    timestamp: number,
    text: string,
  ): Extract<Message, { role: "assistant" }>["blocks"][number] {
    return {
      blockId,
      status: "completed",
      timestamp,
      parentBlockId: null,
      type: "text",
      text,
      providerNotice: null,
    };
  }

  function turnErrorBlock(
    blockId: string,
    timestamp: number,
    code: string | null,
  ): Extract<Message, { role: "assistant" }>["blocks"][number] {
    return {
      blockId,
      status: "completed",
      timestamp,
      parentBlockId: null,
      type: "error",
      message: "Claude is signed out. Reconnect your account to continue.",
      recoverable: true,
      code,
    };
  }

  function turnSteerBlock(
    blockId: string,
    messageId: string,
    timestamp: number,
    sender: UserMessageSender | null,
  ): Extract<Message, { role: "assistant" }>["blocks"][number] {
    return {
      blockId,
      status: "completed",
      timestamp,
      parentBlockId: null,
      type: "steer",
      queueItemId: `queue:${blockId}`,
      messageId,
      content: CONTENT,
      mode: "safe_point",
      sender,
    };
  }

  function liveTurn(
    turnId: string,
    blocks: ReadonlyArray<
      Extract<Message, { role: "assistant" }>["blocks"][number]
    >,
    startedAt: number,
  ): LiveAssistantMessage {
    return {
      turnId,
      sender: ASSISTANT_SENDER,
      blocks,
      startedAt,
      blocksVersion: blocks.length,
      timestamp: startedAt + blocks.length,
      reasoningEffort: null,
      serviceTier: null,
    };
  }

  function partitionInput(
    messages: ReadonlyArray<Message>,
    live: LiveAssistantMessage | null,
  ): RenderedMessagesInput {
    return {
      messages,
      events: [],
      pendingUserMessages: [],
      liveAssistantMessage: live,
      activeTurn: null,
      runStatus: "idle",
      ...BINDING,
    };
  }

  it("keeps settled rows referentially stable across a streaming delta into a multi-record turn", () => {
    const settledAssistant = {
      ...assistantMessage("turn-1", 2000),
      blocks: [turnTextBlock("block-1", 2000, "settled prose")],
    };
    const activeRecord = {
      ...assistantMessage("turn-2", 4000),
      blocks: [turnTextBlock("block-2", 4000, "first chunk")],
    };
    const messages = [userMessage("u1"), settledAssistant, activeRecord];

    const { result, rerender } = renderHook(
      ({ live }: { live: LiveAssistantMessage }) =>
        useRenderedMessages(partitionInput(messages, live), displayContext),
      {
        initialProps: {
          live: liveTurn(
            "turn-2",
            [turnTextBlock("block-3", 4100, "streaming")],
            4000,
          ),
        },
      },
    );
    const first = result.current;

    rerender({
      live: liveTurn(
        "turn-2",
        [
          turnTextBlock("block-3", 4100, "streaming"),
          turnTextBlock("block-4", 4200, "more streaming"),
        ],
        4000,
      ),
    });
    const second = result.current;

    const firstSettledRow = first.find((row) => row.id === "assistant:turn-1");
    const secondSettledRow = second.find(
      (row) => row.id === "assistant:turn-1",
    );
    expect(firstSettledRow).toBeDefined();
    expect(secondSettledRow).toBe(firstSettledRow);

    const firstUserRow = first.find((row) => row.id === "u1");
    expect(second.find((row) => row.id === "u1")).toBe(firstUserRow);

    const firstActiveRow = first.find((row) => row.id === "assistant:turn-2");
    const secondActiveRow = second.find((row) => row.id === "assistant:turn-2");
    expect(firstActiveRow).toBeDefined();
    expect(secondActiveRow).not.toBe(firstActiveRow);
    expect(
      secondActiveRow?.segments.some((segment) =>
        segment.id.startsWith("block-4"),
      ),
    ).toBe(true);
  });

  it("nests a user message steered into the live merging turn without duplicating its row", () => {
    const steered = userMessage("steered-user-1");
    const activeRecord = {
      ...assistantMessage("turn-2", 4000),
      blocks: [turnTextBlock("block-2", 4000, "before steer")],
    };
    const messages = [userMessage("u1"), steered, activeRecord];
    const live = liveTurn(
      "turn-2",
      [turnSteerBlock("steer-1", "steered-user-1", 4100, null)],
      4000,
    );

    const { result } = renderHook(() =>
      useRenderedMessages(partitionInput(messages, live), displayContext),
    );

    const steeredRows = result.current.filter(
      (row) => row.id === "steered-user-1",
    );
    expect(steeredRows).toHaveLength(1);
    // The single row is the NESTED form (anchored at the turn start), not the
    // standalone user row at its own send timestamp.
    expect(steeredRows[0]?.createdAt).toBe(4000);
    expect(steeredRows[0]?.steerBadge).not.toBeNull();
  });

  // An ORPHANED steer block - one whose steered user row is absent from
  // `messages` - falls back to rendering the block's own content. These three
  // pin the provenance of that fallback: it is the only thing standing between
  // an agent-to-agent message and a bubble that looks like the user typed it.
  const AGENT_STEER_SENDER: UserMessageSender = {
    type: "agent",
    harnessId: "claude",
    agentId: "agent-7",
    displayName: "Reviewer",
    reply: { expectsReply: true, responseId: "resp-1" },
  };

  // `turnKey` must be unique per case: rendered rows are memoized by turn/block
  // id, so reusing one would hand back the previous case's row.
  function orphanedSteerRow(turnKey: string, sender: UserMessageSender | null) {
    // Deliberately NOT including the steered user row in `messages` - this is a
    // chat whose mid-turn reload dropped it.
    const activeRecord = {
      ...assistantMessage(turnKey, 4000),
      blocks: [turnTextBlock(`block:${turnKey}`, 4000, "before steer")],
    };
    const live = liveTurn(
      turnKey,
      [
        turnSteerBlock(
          `steer:${turnKey}`,
          `steered-user:${turnKey}`,
          4100,
          sender,
        ),
      ],
      4000,
    );
    const { result } = renderHook(() =>
      useRenderedMessages(
        partitionInput([userMessage("u1"), activeRecord], live),
        displayContext,
      ),
    );
    return result.current.find((row) => row.steerBadge?.status === "steered");
  }

  it("renders an orphaned AGENT steer as an agent card, never as a user-authored row", () => {
    const row = orphanedSteerRow("turn-orphan-agent", AGENT_STEER_SENDER);

    expect(row).toBeDefined();
    // The regression: with no sender on the block this rendered as a plain
    // "YOU" bubble - an A2A message impersonating the user.
    expect(row?.agentSenderInfo).toEqual({
      agentId: "agent-7",
      senderTitle: "Reviewer",
      expectReply: true,
      responseId: "resp-1",
    });
  });

  it("keeps an orphaned HUMAN steer a user row", () => {
    const row = orphanedSteerRow("turn-orphan-human", {
      type: "user",
      userId: "owner-1",
    });

    expect(row).toBeDefined();
    expect(row?.agentSenderInfo).toBeNull();
  });

  it("renders an orphaned steer block persisted before the sender field as a user row", () => {
    // Legacy blocks parse with `sender: null` (the schema default), which must
    // keep the pre-fix behavior rather than inventing provenance.
    const row = orphanedSteerRow("turn-orphan-legacy", null);

    expect(row).toBeDefined();
    expect(row?.agentSenderInfo).toBeNull();
    expect(row?.senderLabel).toBeNull();
  });

  it("re-interleaves settled and active-turn rows in transcript order", () => {
    const settledAssistant = {
      ...assistantMessage("turn-1", 2000),
      blocks: [turnTextBlock("block-1", 2000, "settled")],
    };
    const laterUser = { ...userMessage("u2"), timestamp: 3000 };
    const activeRecord = {
      ...assistantMessage("turn-2", 4000),
      blocks: [turnTextBlock("block-2", 4000, "active")],
    };
    const messages = [
      userMessage("u1"),
      settledAssistant,
      laterUser,
      activeRecord,
    ];
    const live = liveTurn(
      "turn-2",
      [turnTextBlock("block-3", 4100, "streaming")],
      4000,
    );

    const { result } = renderHook(() =>
      useRenderedMessages(partitionInput(messages, live), displayContext),
    );

    expect(result.current.map((row) => row.id)).toEqual([
      "u1",
      "assistant:turn-1",
      "u2",
      "assistant:turn-2",
    ]);
  });

  it("suppresses code:auth error segments while keeping surrounding content", () => {
    const assistant = {
      ...assistantMessage("turn-1", 2000),
      blocks: [
        turnTextBlock("block-1", 2000, "before the failure"),
        turnErrorBlock("block-2", 2001, "auth"),
        turnErrorBlock("block-3", 2002, "RUNTIME_THROWN"),
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        partitionInput([userMessage("u1"), assistant], null),
        displayContext,
      ),
    );

    const row = result.current.find((r) => r.id === "assistant:turn-1");
    expect(row?.segments.some((s) => s.kind === "text")).toBe(true);
    // The auth error is gone; the non-auth error survives.
    const errorSegments = row?.segments.filter((s) => s.kind === "error") ?? [];
    expect(errorSegments).toHaveLength(1);
    const onlyError = errorSegments[0];
    expect(onlyError.code).toBe("RUNTIME_THROWN");
  });

  it("collapses an auth-only turn to zero segments", () => {
    const assistant = {
      ...assistantMessage("turn-1", 2000),
      blocks: [turnErrorBlock("block-1", 2000, "auth")],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        partitionInput([userMessage("u1"), assistant], null),
        displayContext,
      ),
    );

    const row = result.current.find((r) => r.id === "assistant:turn-1");
    expect(row?.segments ?? []).toHaveLength(0);
  });
});
