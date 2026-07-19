import { describe, expect, it } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { InitialChatHandoff } from "@/stores/epics/initial-chat-handoff-store";
import {
  nextHandoffTransition,
  type HandoffTransitionContext,
} from "../next-handoff-transition";
import type { JsonContent } from "@traycer/protocol/common/registry";

const NODE_ID = "chat-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
};

function makeHandoff(
  overrides: Partial<InitialChatHandoff>,
): InitialChatHandoff {
  return {
    key: "scope:epic-1",
    hostId: "host-1",
    userId: "owner-1",
    epicId: "epic-1",
    chatId: NODE_ID,
    status: "waitingChat",
    content: CONTENT,
    settings: {
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "epic",
      profileId: null,
    },
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    clientActionId: null,
    messageId: null,
    failureReason: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<HandoffTransitionContext>,
): HandoffTransitionContext {
  return {
    nodeId: NODE_ID,
    snapshotLoaded: true,
    canAct: true,
    acceptedActions: {},
    messages: [],
    failedSendRestoration: null,
    ...overrides,
  };
}

describe("nextHandoffTransition", () => {
  it("noop when handoff is null and no failed-send restoration", () => {
    expect(nextHandoffTransition(null, makeCtx({}))).toEqual({ kind: "noop" });
  });

  it("noop when the handoff targets a different chat", () => {
    const handoff = makeHandoff({ chatId: "other-chat" });
    expect(nextHandoffTransition(handoff, makeCtx({}))).toEqual({
      kind: "noop",
    });
  });

  it("send when handoff is waitingChat and snapshot is loaded and canAct", () => {
    const handoff = makeHandoff({ status: "waitingChat" });
    expect(nextHandoffTransition(handoff, makeCtx({}))).toEqual({
      kind: "send",
    });
  });

  it("noop when waitingChat but snapshot not loaded", () => {
    const handoff = makeHandoff({ status: "waitingChat" });
    expect(
      nextHandoffTransition(handoff, makeCtx({ snapshotLoaded: false })),
    ).toEqual({ kind: "noop" });
  });

  it("noop when waitingChat but cannot act", () => {
    const handoff = makeHandoff({ status: "waitingChat" });
    expect(nextHandoffTransition(handoff, makeCtx({ canAct: false }))).toEqual({
      kind: "noop",
    });
  });

  it("consume when handoff is sending and the action is accepted", () => {
    const handoff = makeHandoff({
      status: "sending",
      clientActionId: "action-1",
      messageId: "message-1",
    });
    const ctx = makeCtx({
      acceptedActions: {
        "action-1": {
          action: "send",
          interviewBlockId: null,
          clientActionId: "action-1",
          messageId: "message-1",
          acceptedAt: 1000,
          restoreContent: null,
        },
      },
    });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "consume",
      clientActionId: "action-1",
    });
  });

  it("consume when handoff is sending and the message is in messages", () => {
    const handoff = makeHandoff({
      status: "sending",
      clientActionId: "action-1",
      messageId: "message-1",
    });
    const message: Message = {
      role: "user",
      messageId: "message-1",
      sender: { type: "user", userId: "owner-1" },
      message: {
        kind: "user",
        content: CONTENT,
      },
      timestamp: 1000,
      sessionAnchor: null,
    };
    const ctx = makeCtx({ messages: [message] });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "consume",
      clientActionId: "action-1",
    });
  });

  it("markFailedByAction when restoration matches handoff and handoff is not yet failed", () => {
    const handoff = makeHandoff({
      status: "sending",
      clientActionId: "action-1",
    });
    const ctx = makeCtx({
      failedSendRestoration: {
        clientActionId: "action-1",
        content: CONTENT,
        reason: "Rejected",
      },
    });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "markFailedByAction",
      clientActionId: "action-1",
      reason: "Rejected",
    });
  });

  it("restoreAndAckFailed when restoration matches handoff that has already moved to failed", () => {
    const handoff = makeHandoff({
      status: "failed",
      clientActionId: "action-1",
    });
    const ctx = makeCtx({
      failedSendRestoration: {
        clientActionId: "action-1",
        content: CONTENT,
        reason: "Rejected",
      },
    });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "restoreAndAckFailed",
      clientActionId: "action-1",
      content: CONTENT,
    });
  });

  it("restoreAndAckFailed when restoration exists and no handoff matches", () => {
    const ctx = makeCtx({
      failedSendRestoration: {
        clientActionId: "action-1",
        content: CONTENT,
        reason: "Rejected",
      },
    });
    expect(nextHandoffTransition(null, ctx)).toEqual({
      kind: "restoreAndAckFailed",
      clientActionId: "action-1",
      content: CONTENT,
    });
  });
});
