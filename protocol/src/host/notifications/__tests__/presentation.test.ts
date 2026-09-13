import { describe, expect, it } from "vitest";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/host-notifications";
import {
  formatHostNotificationPresentation,
  FALLBACK_REASON_LABELS,
  FALLBACK_RUNG_LABELS,
  fallbackReasonLabel,
  fallbackRungLabel,
} from "@traycer/protocol/host/notifications/presentation";
import { HOST_NOTIFICATION_STOPPED_REASONS } from "@traycer/protocol/host/notifications/payloads";
import { FALLBACK_RUNG_KINDS } from "@traycer/protocol/host/fallback-policy";

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

// ─── FALLBACK_REASON_LABELS / fallbackReasonLabel totality (ticket 01) ────
describe("FALLBACK_REASON_LABELS", () => {
  it("is total over HOST_NOTIFICATION_STOPPED_REASONS - every reason has a non-empty label", () => {
    for (const reason of HOST_NOTIFICATION_STOPPED_REASONS) {
      const label = FALLBACK_REASON_LABELS[reason];
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
    // Same set, no extras and no gaps - `Record<HostNotificationStoppedReason,
    // string>` already guarantees no gaps at compile time; this also catches
    // a stray key that no longer names a live reason.
    expect(Object.keys(FALLBACK_REASON_LABELS).sort()).toEqual(
      [...HOST_NOTIFICATION_STOPPED_REASONS].sort(),
    );
  });

  it("fallbackReasonLabel indexes the same map for every persisted AgentFailureReason", () => {
    for (const reason of HOST_NOTIFICATION_STOPPED_REASONS) {
      expect(fallbackReasonLabel(reason)).toBe(FALLBACK_REASON_LABELS[reason]);
    }
  });
});

// ─── FALLBACK_RUNG_LABELS / fallbackRungLabel ────────────────────────────
//
// The `Step` row of the fallback-applied notice used to render the step id
// itself (`Rung: tier`). Nothing caught it because nothing pinned that row's
// copy at all - so these assert the RULE that was violated, not the strings,
// and would fail the same way for a fifth step pasted in as its own id.
describe("FALLBACK_RUNG_LABELS", () => {
  const RUNG_KEYS = [...FALLBACK_RUNG_KINDS, "manual"] as const;

  it("is total over the ladder steps plus `manual`, with no gaps or strays", () => {
    expect(Object.keys(FALLBACK_RUNG_LABELS).sort()).toEqual(
      [...RUNG_KEYS].sort(),
    );
  });

  it("never renders a step id as its own label", () => {
    for (const rung of RUNG_KEYS) {
      const label = fallbackRungLabel(rung);
      expect(label.length).toBeGreaterThan(0);
      // The exact defect: the value equal to the key.
      expect(label).not.toBe(rung);
      // And its signature. Every id in this vocabulary is snake_case or a
      // bare lowercase word, so a label that is all-lowercase-with-no-space
      // is an id that got pasted in, whatever it is named.
      expect(label).toMatch(/[A-Z\s]/);
      expect(label).not.toContain("_");
    }
  });

  it("never uses the engine words the ux-surfaces vocabulary forbids", () => {
    for (const rung of RUNG_KEYS) {
      expect(fallbackRungLabel(rung).toLowerCase()).not.toMatch(
        /\b(rung|ladder)\b/,
      );
    }
  });
});

// ─── agentStoppedFailureStatus byte-identity pin (ticket 01) ──────────────
//
// `agentStoppedFailureStatus` is private; reached only through
// `formatHostNotificationPresentation`'s `body` for a `chat` payload with
// `outcome: "errored"`. This pins its EXACT output for every reason in
// `HOST_NOTIFICATION_STOPPED_REASONS`, with and without provider attribution
// where the source varies by it, so a future edit to the new
// `FALLBACK_REASON_LABELS` map (a NOUN PHRASE, deliberately a second map) can
// never be mistaken for touching this one (SENTENCE-shaped, provider-aware,
// "must not change").
function erroredChatEntry(
  reason: string,
  providerId: string | undefined,
): HostNotificationEntry {
  return {
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
      reason,
      ...(providerId === undefined ? {} : { providerId }),
    },
  };
}

describe("agentStoppedFailureStatus byte-identity pins", () => {
  it("auth", () => {
    expect(
      formatHostNotificationPresentation(erroredChatEntry("auth", undefined))
        .body,
    ).toBe("Long refactor • Provider is signed out. Reconnect to continue.");
    expect(
      formatHostNotificationPresentation(erroredChatEntry("auth", "codex"))
        .body,
    ).toBe("Long refactor • Codex is signed out. Reconnect to continue.");
    // Reasonix's auth sentence names the real fix (no account to reconnect).
    expect(
      formatHostNotificationPresentation(erroredChatEntry("auth", "reasonix"))
        .body,
    ).toBe(
      "Long refactor • Reasonix has no usable API key configured. Run reasonix setup to continue.",
    );
  });

  it("rate_limit", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("rate_limit", undefined),
      ).body,
    ).toBe("Long refactor • Rate limit reached");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("rate_limit", "codex"),
      ).body,
    ).toBe("Long refactor • Codex rate limit reached");
  });

  it("billing", () => {
    expect(
      formatHostNotificationPresentation(erroredChatEntry("billing", undefined))
        .body,
    ).toBe("Long refactor • Provider billing issue");
    expect(
      formatHostNotificationPresentation(erroredChatEntry("billing", "codex"))
        .body,
    ).toBe("Long refactor • Codex billing issue");
  });

  it("model_unavailable - no provider variant", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("model_unavailable", undefined),
      ).body,
    ).toBe("Long refactor • Model unavailable");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("model_unavailable", "codex"),
      ).body,
    ).toBe("Long refactor • Model unavailable");
  });

  it("provider_unavailable", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("provider_unavailable", undefined),
      ).body,
    ).toBe("Long refactor • Provider is temporarily unavailable");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("provider_unavailable", "codex"),
      ).body,
    ).toBe("Long refactor • Codex is temporarily unavailable");
  });

  it("provider_connection_failed", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("provider_connection_failed", undefined),
      ).body,
    ).toBe("Long refactor • Provider connection failed");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("provider_connection_failed", "codex"),
      ).body,
    ).toBe("Long refactor • Connection to Codex failed");
  });

  it("context_exhausted - provider-neutral even with a known provider", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("context_exhausted", undefined),
      ).body,
    ).toBe("Long refactor • Context limit reached");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("context_exhausted", "codex"),
      ).body,
    ).toBe("Long refactor • Context limit reached");
  });

  it("request_rejected", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("request_rejected", undefined),
      ).body,
    ).toBe("Long refactor • Provider rejected the request");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("request_rejected", "codex"),
      ).body,
    ).toBe("Long refactor • Codex rejected the request");
  });

  it("turn_start_timeout - no provider variant", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("turn_start_timeout", undefined),
      ).body,
    ).toBe("Long refactor • Provider did not start in time");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("turn_start_timeout", "codex"),
      ).body,
    ).toBe("Long refactor • Provider did not start in time");
  });

  it("missing_terminal_event - no provider variant", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("missing_terminal_event", undefined),
      ).body,
    ).toBe("Long refactor • Provider stopped responding");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("missing_terminal_event", "codex"),
      ).body,
    ).toBe("Long refactor • Provider stopped responding");
  });

  it("background_work_failed - no provider variant", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("background_work_failed", undefined),
      ).body,
    ).toBe("Long refactor • Background work stopped");
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("background_work_failed", "codex"),
      ).body,
    ).toBe("Long refactor • Background work stopped");
  });

  it("session_budget - no provider variant", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("session_budget", undefined),
      ).body,
    ).toBe("Long refactor • Session limit reached");
    // Provider-neutral BY DESIGN, like `context_exhausted` above: the limit is
    // a property of the conversation, not of the account or the vendor, and
    // naming the provider would re-suggest the account-level reading that made
    // this a `rate_limit` in the first place.
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("session_budget", "codex"),
      ).body,
    ).toBe("Long refactor • Session limit reached");
  });

  it("an unknown/null reason falls through to the generic 'Failed'", () => {
    expect(
      formatHostNotificationPresentation(
        erroredChatEntry("something_new_and_unrecognized", undefined),
      ).body,
    ).toBe("Long refactor • Failed");
  });

  it("every HOST_NOTIFICATION_STOPPED_REASONS member is covered by name above", () => {
    // Belt-and-suspenders against a reason added to the taxonomy without a
    // matching pin here - the individual `it`s above are what actually pin
    // the copy, but this fails loudly if the enum grows unnoticed.
    const pinned = new Set([
      "auth",
      "rate_limit",
      "billing",
      "model_unavailable",
      "provider_unavailable",
      "provider_connection_failed",
      "context_exhausted",
      "request_rejected",
      "turn_start_timeout",
      "missing_terminal_event",
      "background_work_failed",
      "session_budget",
    ]);
    expect(new Set(HOST_NOTIFICATION_STOPPED_REASONS)).toEqual(pinned);
  });
});
