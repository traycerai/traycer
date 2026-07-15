import { describe, expect, it } from "vitest";
import {
  hostNotificationPayloadWithChatTitle,
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
  // fields must still parse - and the extras must survive the round trip so
  // in-place patches (retitle) cannot strip data a newer reader relies on.
  it("keeps unknown extra fields through parse and patch", () => {
    const parsed = parseKnownHostNotificationPayload({
      ...CHAT_STOPPED,
      futureField: "future-value",
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed).toMatchObject({ futureField: "future-value" });
    const patched = hostNotificationPayloadWithChatTitle(parsed, "New title");
    expect(patched).toMatchObject({
      agentName: "New title",
      futureField: "future-value",
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
  });
});

describe("hostNotificationPayloadWithChatTitle", () => {
  it("routes the title to the kind-specific field", () => {
    const chat = parseKnownHostNotificationPayload(CHAT_STOPPED);
    const approval = parseKnownHostNotificationPayload(APPROVAL);
    expect(chat).not.toBeNull();
    expect(approval).not.toBeNull();
    if (chat === null || approval === null) return;
    expect(hostNotificationPayloadWithChatTitle(chat, "Renamed")).toMatchObject(
      { kind: "chat", agentName: "Renamed" },
    );
    expect(
      hostNotificationPayloadWithChatTitle(approval, "Renamed"),
    ).toMatchObject({ kind: "approval", chatTitle: "Renamed" });
  });

  it("returns null for same-title no-ops and for TUI epic payloads", () => {
    const chat = parseKnownHostNotificationPayload(CHAT_STOPPED);
    const epic = parseKnownHostNotificationPayload({
      kind: "epic",
      epicId: "epic-1",
      tuiAgentId: "tui-1",
      agentName: "Terminal agent",
      taskTitle: "Checkout notifications",
      outcome: "completed",
    });
    expect(chat).not.toBeNull();
    expect(epic).not.toBeNull();
    if (chat === null || epic === null) return;
    expect(
      hostNotificationPayloadWithChatTitle(chat, "Deploy checkout fix"),
    ).toBeNull();
    expect(hostNotificationPayloadWithChatTitle(epic, "Anything")).toBeNull();
  });
});
