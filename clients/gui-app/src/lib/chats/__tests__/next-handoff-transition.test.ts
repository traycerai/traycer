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
      identityId: null,
    },
    worktreeIntent: null,
    placement: null,
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
    deliveryMessageId: null,
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

  it("consumes with no send when waitingChat and the delivery view names the handoff's message - even when the viewer cannot act", () => {
    // The host already holds this prompt (it named it before anything was
    // ever sent from this handoff), so a resend would be a duplicate. This
    // check runs BEFORE the canAct gate: an unresolved delivery still
    // consumes the handoff even though nothing here is actionable yet.
    const handoff = makeHandoff({
      status: "waitingChat",
      messageId: "message-1",
    });
    const ctx = makeCtx({ canAct: false, deliveryMessageId: "message-1" });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "consume",
      clientActionId: null,
    });
  });

  it("still sends when waitingChat and the delivery view names a DIFFERENT message", () => {
    const handoff = makeHandoff({
      status: "waitingChat",
      messageId: "message-1",
    });
    const ctx = makeCtx({ deliveryMessageId: "message-2" });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({ kind: "send" });
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
          queueItemId: null,
          checkpointId: null,
          revertArtifacts: null,
          interviewBlockId: null,
          interviewDeliveryRetry: null,
          clientActionId: "action-1",
          messageId: "message-1",
          acceptedAt: 1000,
          restore: null,
          sender: null,
          settings: null,
          accountContext: null,
          deliveryPolicy: null,
          restoreWorktreeIntent: null,
          displayWorktreeIntent: null,
          connectionEpoch: 0,
          confirmedByHost: false,
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
        browserAnnotations: [],
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

  it("consume when handoff is sending and the delivery view names the handoff's message, with no matching accepted action or transcript row", () => {
    const handoff = makeHandoff({
      status: "sending",
      clientActionId: "action-1",
      messageId: "message-1",
    });
    const ctx = makeCtx({ deliveryMessageId: "message-1" });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "consume",
      clientActionId: "action-1",
    });
  });

  it("noop when handoff is sending and the delivery view names a DIFFERENT message", () => {
    const handoff = makeHandoff({
      status: "sending",
      clientActionId: "action-1",
      messageId: "message-1",
    });
    const ctx = makeCtx({ deliveryMessageId: "message-2" });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({ kind: "noop" });
  });

  it("markFailedByAction when restoration matches handoff and handoff is not yet failed", () => {
    const handoff = makeHandoff({
      status: "sending",
      clientActionId: "action-1",
    });
    const ctx = makeCtx({
      failedSendRestoration: {
        clientActionId: "action-1",
        messageId: null,
        content: CONTENT,
        browserAnnotations: [],
        reason: "Rejected",
        displacedReason: "Rejected",
        stated: false,
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
        messageId: null,
        content: CONTENT,
        browserAnnotations: [],
        reason: "Rejected",
        displacedReason: "Rejected",
        stated: false,
      },
    });
    expect(nextHandoffTransition(handoff, ctx)).toEqual({
      kind: "restoreAndAckFailed",
      clientActionId: "action-1",
      content: CONTENT,
      browserAnnotations: [],
    });
  });

  it("restoreAndAckFailed when restoration exists and no handoff matches", () => {
    const ctx = makeCtx({
      failedSendRestoration: {
        clientActionId: "action-1",
        messageId: null,
        content: CONTENT,
        browserAnnotations: [],
        reason: "Rejected",
        displacedReason: "Rejected",
        stated: false,
      },
    });
    expect(nextHandoffTransition(null, ctx)).toEqual({
      kind: "restoreAndAckFailed",
      clientActionId: "action-1",
      content: CONTENT,
      browserAnnotations: [],
    });
  });
});
