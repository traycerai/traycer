import { describe, expect, it } from "vitest";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/host-notifications";
import { formatHostNotificationPresentation } from "@traycer/protocol/host/notifications/presentation";

const BASE = {
  id: "notification-1",
  updatedAt: 10,
  readAt: null,
  sourceRef: "source-1",
  epicId: "epic-1",
  chatId: "chat-1",
} as const;

const CASES: readonly {
  readonly name: string;
  readonly entry: HostNotificationEntry;
  readonly title: string;
  readonly body: string;
}[] = [
  {
    name: "completed GUI agent",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Implement confirmation policy",
        taskTitle: "Script Execution Confirmation Policy",
        outcome: "completed",
      },
    },
    title: "Script Execution Confirmation Policy",
    body: "Implement confirmation policy • Done",
  },
  {
    name: "completed GUI agent with background work still running",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "done",
      outcome: "completed",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Repo survey agent",
        taskTitle:
          "Spin up a Cursor, Fable agent to find out what this repo is about",
        outcome: "completed",
        backgroundWorkRunning: true,
      },
    },
    title: "Spin up a Cursor, Fable agent to find out what this repo is about",
    body: "Repo survey agent • Background work running",
  },
  {
    name: "stopped terminal agent",
    entry: {
      ...BASE,
      chatId: null,
      kind: "agent.stopped",
      severity: "done",
      outcome: "stopped",
      payload: {
        kind: "epic",
        epicId: "epic-1",
        tuiAgentId: "agent-1",
        agentName: "Build worker",
        taskTitle: "Background build",
        outcome: "stopped",
      },
    },
    title: "Background build",
    body: "Build worker • Stopped",
  },
  {
    name: "provider-specific rate limit",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Rate Limit Banner Implementation",
        taskTitle: "Rate Limit Indicator Implementation",
        outcome: "errored",
        reason: "rate_limit",
        providerId: "claude-code",
      },
    },
    title: "Rate Limit Indicator Implementation",
    body: "Rate Limit Banner Implementation • Claude Code rate limit reached",
  },
  {
    name: "context exhaustion",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Long refactor",
        taskTitle: "Notification reliability",
        outcome: "errored",
        reason: "context_exhausted",
        providerId: "codex",
      },
    },
    title: "Notification reliability",
    // Context exhaustion is the session's fault, not the provider's — the copy
    // stays provider-neutral even when the provider is known.
    body: "Long refactor • Context limit reached",
  },
  {
    name: "provider-specific rejected request",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Long refactor",
        taskTitle: "Notification reliability",
        outcome: "errored",
        reason: "request_rejected",
        providerId: "codex",
      },
    },
    title: "Notification reliability",
    body: "Long refactor • Codex rejected the request",
  },
  {
    name: "rejected request without provider attribution",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Long refactor",
        taskTitle: "Notification reliability",
        outcome: "errored",
        reason: "request_rejected",
      },
    },
    title: "Notification reliability",
    body: "Long refactor • Provider rejected the request",
  },
  {
    // Compatibility fallback: rows minted before `reason` was persisted still
    // derive their copy from the stamped code.
    name: "connection failure derived from a code-only row",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Long refactor",
        taskTitle: "Notification reliability",
        outcome: "errored",
        code: "connection_failed",
        providerId: "codex",
      },
    },
    title: "Notification reliability",
    body: "Long refactor • Connection to Codex failed",
  },
  {
    name: "context exhaustion derived from a code-only row",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Long refactor",
        taskTitle: "Notification reliability",
        outcome: "errored",
        code: "context_window_exceeded",
      },
    },
    title: "Notification reliability",
    body: "Long refactor • Context limit reached",
  },
  {
    name: "rejected request derived from a code-only row",
    entry: {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Long refactor",
        taskTitle: "Notification reliability",
        outcome: "errored",
        code: "invalid_request",
        providerId: "claude-code",
      },
    },
    title: "Notification reliability",
    body: "Long refactor • Claude Code rejected the request",
  },
  {
    name: "buffering stall",
    entry: {
      ...BASE,
      kind: "agent.stalled",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "agent_stalled",
        epicId: "epic-1",
        chatId: "chat-1",
        agentId: "agent-1",
        agentName: "Long-running analysis",
        taskTitle: "Notification reliability",
        reason: "provider_buffering",
        title: "Provider is buffering",
        outcome: "errored",
      },
    },
    title: "Notification reliability",
    body: "Long-running analysis • Provider is taking longer than expected",
  },
  {
    name: "workspace setup failure",
    entry: {
      ...BASE,
      kind: "workspace.operation.failed",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "workspace_operation_failed",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Prepare workspace",
        taskTitle: "Developer environment",
        operation: "setup",
        title: "Workspace setup failed",
        message: "Setup exited with code 1.",
        outcome: "errored",
      },
    },
    title: "Developer environment",
    body: "Prepare workspace • Workspace setup failed",
  },
  {
    name: "approval request",
    entry: {
      ...BASE,
      kind: "approval.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Apply database migration",
        taskTitle: "Production rollout",
        approvalId: "approval-1",
      },
    },
    title: "Production rollout",
    body: "Apply database migration • Approval requested",
  },
  {
    name: "interview request",
    entry: {
      ...BASE,
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Rate Limit Banner Implementation",
        taskTitle: "Rate Limit Indicator Implementation",
        interviewBlockId: "interview-1",
      },
    },
    title: "Rate Limit Indicator Implementation",
    body: "Rate Limit Banner Implementation • Question waiting",
  },
  {
    name: "resolved approval request",
    entry: {
      ...BASE,
      kind: "approval.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: 1_700_000_000_100,
      payload: {
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Apply database migration",
        taskTitle: "Production rollout",
        approvalId: "approval-1",
      },
    },
    title: "Production rollout",
    body: "Apply database migration • Approval resolved",
  },
  {
    name: "resolved interview request",
    entry: {
      ...BASE,
      kind: "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: 1_700_000_000_100,
      payload: {
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Rate Limit Banner Implementation",
        taskTitle: "Rate Limit Indicator Implementation",
        interviewBlockId: "interview-1",
      },
    },
    title: "Rate Limit Indicator Implementation",
    body: "Rate Limit Banner Implementation • Question resolved",
  },
  {
    name: "cross-kind malformed payload",
    entry: {
      ...BASE,
      kind: "approval.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: {
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Wrong shape",
        taskTitle: "Wrong shape",
        interviewBlockId: "interview-1",
      },
    },
    title: "Task",
    body: "Agent • Approval requested",
  },
];

describe("formatHostNotificationPresentation", () => {
  it.each(CASES)("formats $name", ({ entry, title, body }) => {
    expect(formatHostNotificationPresentation(entry)).toEqual({ title, body });
  });

  it("keeps unknown failure codes generic instead of exposing raw messages", () => {
    const entry: HostNotificationEntry = {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Private chat title",
        taskTitle: "Private task title",
        outcome: "errored",
        code: "future_sensitive_failure",
        message: "raw provider text must not become presentation copy",
      },
    };

    expect(formatHostNotificationPresentation(entry)).toEqual({
      title: "Private task title",
      body: "Private chat title • Failed",
    });
  });

  // Cross-version degrade: an older renderer reading a row whose `reason` a
  // NEWER host persisted must fall through to generic copy, never throw or
  // surface the unrecognised taxonomy string.
  it("keeps an unknown persisted reason generic", () => {
    const entry: HostNotificationEntry = {
      ...BASE,
      kind: "agent.stopped",
      severity: "failure",
      outcome: "errored",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        agentName: "Private chat title",
        taskTitle: "Private task title",
        outcome: "errored",
        code: "future_code",
        reason: "future_taxonomy_reason",
        providerId: "codex",
      },
    };

    expect(formatHostNotificationPresentation(entry)).toEqual({
      title: "Private task title",
      body: "Private chat title • Failed",
    });
  });
});
