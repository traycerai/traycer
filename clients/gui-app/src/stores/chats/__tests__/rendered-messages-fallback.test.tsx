import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type {
  AgentSender,
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";

const BINDING = {
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat" as const,
  viewTabId: "tab-1",
};

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: (_sender, reasoningEffort) =>
    reasoningEffort === null ? null : `Resolved ${reasoningEffort}`,
  contentBlocksPreview: () => "",
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
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function renderRenderedMessages(patch: Partial<RenderedMessagesInput>) {
  const value: RenderedMessagesInput = {
    messages: [],
    events: [],
    rowContext: {},
    pendingUserMessages: [],
    liveAssistantMessage: null,
    activeTurn: null,
    runStatus: "idle",
    setupCardWindows: [],
    ...BINDING,
    ...patch,
  };
  return renderHook(
    ({ current }: { current: RenderedMessagesInput }) =>
      useRenderedMessages(current, displayContext),
    { initialProps: { current: value } },
  );
}

describe("useRenderedMessages fallback projection", () => {
  it("projects providerNotice.noticeKind onto the provider_notice segment", () => {
    const assistant = assistantMessage("turn-fallback-notice", 2000);
    const { result } = renderRenderedMessages({
      messages: [
        {
          ...assistant,
          blocks: [
            {
              type: "text",
              blockId: "notice-1",
              status: "completed",
              timestamp: 2001,
              text: "Switched providers.",
              providerNotice: {
                harnessId: "claude",
                noticeKind: "fallback_applied",
                tone: "info",
                title: "Switched providers",
                message: "Moved to Codex.",
                details: [{ label: "via:", value: "Claude Code → Codex" }],
                metadata: null,
              },
            },
          ],
        },
      ],
    });
    const notice = result.current[0]?.segments[0];
    expect(notice.kind).toBe("provider_notice");
    if (notice.kind !== "provider_notice") {
      throw new Error("expected provider_notice");
    }
    expect(notice.noticeKind).toBe("fallback_applied");
  });

  it("projects errorBlock.failure onto the error segment", () => {
    const assistant = assistantMessage("turn-fallback-error", 2000);
    const { result } = renderRenderedMessages({
      messages: [
        {
          ...assistant,
          blocks: [
            {
              type: "error",
              blockId: "error-1",
              status: "completed",
              timestamp: 2001,
              message: "Signed out.",
              recoverable: true,
              code: "auth",
              failure: { reason: "auth" },
            },
          ],
        },
      ],
    });
    const error = result.current[0]?.segments[0];
    expect(error.kind).toBe("error");
    if (error.kind !== "error") {
      throw new Error("expected error");
    }
    expect(error.failure).toEqual({ reason: "auth" });
  });

  it("carries failure: null on a synthesized session-anchor error row", () => {
    const failure = {
      eventId: "queued-preparation-failure",
      type: "send.failed",
      timestamp: 2_000,
      clientActionId: null,
      actor: null,
      message: "The queued prompt could not be prepared.",
      turnId: null,
      messageId: null,
      queueItemId: "queue-item-1",
      approvalId: null,
      blockId: null,
      severity: "warning",
      metadata: {
        code: "QUEUED_PROMPT_PREPARATION_FAILED",
        notificationAnchor: true,
      },
    } satisfies ChatEvent;
    const { result } = renderRenderedMessages({ events: [failure] });
    const error = result.current[0]?.segments[0];
    expect(error.kind).toBe("error");
    if (error.kind !== "error") {
      throw new Error("expected error");
    }
    expect(error.failure).toBeNull();
  });

  it("projects no provider_notice or error segment from a transcript with only a text block", () => {
    const assistant = assistantMessage("turn-retry-absence", 2000);
    const { result } = renderRenderedMessages({
      messages: [
        {
          ...assistant,
          blocks: [
            {
              type: "text",
              blockId: "text-1",
              status: "completed",
              timestamp: 2001,
              text: "Working.",
              providerNotice: null,
            },
          ],
        },
      ],
    });
    const kinds = (result.current[0]?.segments ?? []).map(
      (segment) => segment.kind,
    );
    expect(kinds).toEqual(["text"]);
    expect(kinds).not.toContain("provider_notice");
    expect(kinds).not.toContain("error");
    // Honest gap: useRenderedMessages does not take pendingFallback, so a
    // retrying DTO cannot appear in this projection. That absence is the
    // structural pin that the retry row is not a MessageSegment.
  });
});
