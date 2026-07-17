import { describe, expect, it } from "vitest";
import {
  deriveHostNotificationStoppedReason,
  parseKnownHostNotificationPayload,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/payloads";

const CHAT_STOPPED = {
  kind: "chat",
  epicId: "epic-1",
  chatId: "chat-1",
  agentName: "Deploy checkout fix",
  taskTitle: "Checkout notifications",
  outcome: "completed",
};

const APPROVAL = {
  kind: "approval",
  epicId: "epic-1",
  chatId: "chat-1",
  chatTitle: "Deploy checkout fix",
  taskTitle: "Checkout notifications",
  approvalId: "approval-1",
};

describe("parseKnownHostNotificationPayload", () => {
  it("parses every known payload kind", () => {
    expect(parseKnownHostNotificationPayload(CHAT_STOPPED)).toMatchObject({
      kind: "chat",
      agentName: "Deploy checkout fix",
    });
    expect(
      parseKnownHostNotificationPayload({
        kind: "epic",
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        agentName: "Terminal agent",
        taskTitle: "Checkout notifications",
        outcome: "errored",
        code: "RATE_LIMIT",
        message: "rate limited",
      }),
    ).toMatchObject({ kind: "epic", tuiAgentId: "tui-1" });
    expect(
      parseKnownHostNotificationPayload({
        kind: "agent_stalled",
        epicId: "epic-1",
        chatId: "chat-1",
        agentId: "chat-1",
        agentName: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        reason: "provider_buffering",
        title: "Provider is buffering",
        outcome: "errored",
      }),
    ).toMatchObject({ kind: "agent_stalled", reason: "provider_buffering" });
    expect(
      parseKnownHostNotificationPayload({
        kind: "workspace_operation_failed",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        operation: "setup",
        title: "Workspace setup failed",
        message: "Setup exited with code 1.",
        setupExitCode: 1,
        outcome: "errored",
      }),
    ).toMatchObject({
      kind: "workspace_operation_failed",
      operation: "setup",
      setupExitCode: 1,
    });
    expect(parseKnownHostNotificationPayload(APPROVAL)).toMatchObject({
      kind: "approval",
      approvalId: "approval-1",
    });
    expect(
      parseKnownHostNotificationPayload({
        kind: "interview",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        interviewBlockId: "block-1",
      }),
    ).toMatchObject({ kind: "interview", interviewBlockId: "block-1" });
  });

  // Forward compatibility: a payload written by a NEWER producer with extra
  // fields must still parse, and the extras must survive the round trip so
  // an enrichment pass cannot strip data a newer reader relies on.
  it("keeps unknown extra fields through parse", () => {
    const parsed = parseKnownHostNotificationPayload({
      ...CHAT_STOPPED,
      futureField: "future-value",
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed).toMatchObject({ futureField: "future-value" });
  });

  it("accepts additive stopped reason and provider attribution fields", () => {
    expect(
      parseKnownHostNotificationPayload({
        ...CHAT_STOPPED,
        outcome: "errored",
        code: "auth",
        reason: "auth",
        providerId: "claude-code",
      }),
    ).toMatchObject({
      kind: "chat",
      code: "auth",
      reason: "auth",
      providerId: "claude-code",
    });
  });

  it("keeps a future provider id without invalidating the known payload", () => {
    expect(
      parseKnownHostNotificationPayload({
        ...CHAT_STOPPED,
        providerId: "future-provider",
      }),
    ).toMatchObject({
      kind: "chat",
      providerId: "future-provider",
    });
  });

  // A malformed row with empty identifiers must degrade rather than mint an
  // unusable deep-link.
  it("rejects empty identifier fields", () => {
    expect(
      parseKnownHostNotificationPayload({ ...CHAT_STOPPED, epicId: "" }),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayload({ ...APPROVAL, approvalId: "" }),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayload({ ...APPROVAL, chatId: "" }),
    ).toBeNull();
  });

  // Degradation contract: unknown discriminators, wrong field types, and
  // non-object payloads all produce null (generic rendering), never a throw.
  it("returns null for unknown kinds, wrong types, and non-objects", () => {
    expect(
      parseKnownHostNotificationPayload({
        kind: "future_shape",
        epicId: "epic-1",
      }),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayload({ ...CHAT_STOPPED, agentName: 42 }),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayload({ ...APPROVAL, approvalId: null }),
    ).toBeNull();
    expect(parseKnownHostNotificationPayload("not a record")).toBeNull();
    expect(parseKnownHostNotificationPayload(null)).toBeNull();
    expect(parseKnownHostNotificationPayload(undefined)).toBeNull();
    expect(parseKnownHostNotificationPayload([CHAT_STOPPED])).toBeNull();
  });
});

describe("deriveHostNotificationStoppedReason", () => {
  it.each([
    ["auth", "auth"],
    ["rate_limit", "rate_limit"],
    ["RATE_LIMIT", "rate_limit"],
    ["usage_limit_exceeded", "rate_limit"],
    ["session_budget_exceeded", "rate_limit"],
    ["billing_error", "billing"],
    ["model_not_found", "model_unavailable"],
    ["overloaded", "provider_unavailable"],
    ["server_error", "provider_unavailable"],
    ["CLAUDE_CODE_TRANSPORT", "provider_connection_failed"],
    ["TURN_START_TIMEOUT", "turn_start_timeout"],
    ["MISSING_TERMINAL_EVENT", "missing_terminal_event"],
    ["background_work_died", "background_work_failed"],
  ])("normalizes %s to %s", (code, reason) => {
    expect(deriveHostNotificationStoppedReason(code)).toBe(reason);
  });

  it.each([
    null,
    "MISSING_API_KEY",
    "invalid_request",
    "refusal",
    "RUNTIME_THROWN",
    "TURN_FINALIZATION_FAILED",
    "future_error",
  ])("keeps unsafe or unknown code %s generic", (code) => {
    expect(deriveHostNotificationStoppedReason(code)).toBeNull();
  });
});

describe("parseKnownHostNotificationPayloadForKind", () => {
  it("accepts only the payload arms belonging to the notification kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stopped", CHAT_STOPPED),
    ).toMatchObject({ kind: "chat" });
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stopped", {
        kind: "epic",
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        agentName: "Terminal agent",
        taskTitle: "Checkout notifications",
        outcome: "completed",
      }),
    ).toMatchObject({ kind: "epic" });
    expect(
      parseKnownHostNotificationPayloadForKind("approval.requested", APPROVAL),
    ).toMatchObject({ kind: "approval" });
    expect(
      parseKnownHostNotificationPayloadForKind("workspace.operation.failed", {
        kind: "workspace_operation_failed",
        epicId: "epic-1",
        chatId: "chat-1",
        chatTitle: "Deploy checkout fix",
        taskTitle: "Checkout notifications",
        operation: "provision",
        title: "Worktree creation failed",
        message: "Couldn't create worktree.",
        outcome: "errored",
      }),
    ).toMatchObject({
      kind: "workspace_operation_failed",
      operation: "provision",
    });
  });

  // Cross-kind corruption: a valid payload shape under the WRONG notification
  // kind is malformed row data and must take the generic/null path instead of
  // minting contradictory presentation, navigation, or webhook output.
  it("rejects a valid payload shape under a mismatched notification kind", () => {
    expect(
      parseKnownHostNotificationPayloadForKind(
        "approval.requested",
        CHAT_STOPPED,
      ),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stopped", APPROVAL),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stalled", CHAT_STOPPED),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("interview.requested", APPROVAL),
    ).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind(
        "workspace.operation.failed",
        APPROVAL,
      ),
    ).toBeNull();
  });
});
