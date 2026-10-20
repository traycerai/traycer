/**
 * The conversation request state on a bot conversation's user rows (Tracy
 * Bots): `renderUserMessage` carries `conversationRequest` from the persisted
 * row onto the rendered model, and `<ChatMessage>` draws the Open / Resolved
 * badge with a "See reply" jump when the surface can scroll to one. The
 * sending member's picture rides the same rows (`senderAvatarUrl`).
 */
import { StrictMode, type ReactNode } from "react";
import {
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ConversationRequest } from "@traycer/protocol/persistence/epic/messages";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { ChatMessage } from "@/components/chat/chat-message";
import {
  ChatConversationRequestContext,
  type ChatConversationRequestScroller,
} from "@/components/chat/chat-conversation-request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

afterEach(() => {
  cleanup();
});

function userRow(
  conversationRequest: ConversationRequest | undefined,
): ChatMessageModel {
  const base = makeMessage(0, "user");
  return conversationRequest === undefined
    ? base
    : { ...base, conversationRequest };
}

function renderRow(
  message: ChatMessageModel,
  scroller: ChatConversationRequestScroller | null,
): void {
  function Providers(props: { readonly children: ReactNode }) {
    return (
      <StrictMode>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <ChatConversationRequestContext.Provider value={scroller}>
              {props.children}
            </ChatConversationRequestContext.Provider>
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </StrictMode>
    );
  }
  render(
    <ChatMessage
      message={message}
      actions={null}
      backgroundToolBlockIds={EMPTY_BACKGROUND_TOOL_BLOCK_IDS}
      nextStepActions={null}
    />,
    { wrapper: Providers },
  );
}

describe("<ChatMessage /> conversation request line", () => {
  it("shows an Open badge and no reply link for an unresolved request", () => {
    const scroller = vi.fn();
    renderRow(
      userRow({
        requestId: "req-1",
        resolvedAt: null,
        resolvedByMessageId: null,
      }),
      scroller,
    );

    const line = screen.getByTestId("conversation-request");
    expect(line.getAttribute("data-request-state")).toBe("open");
    expect(line.getAttribute("data-request-id")).toBe("req-1");
    expect(within(line).getByText("Open")).toBeTruthy();
    expect(within(line).queryByText("Resolved")).toBeNull();
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("shows a Resolved badge and a reply link whose click reaches the scroller with the reply id", async () => {
    const user = userEvent.setup();
    const scroller = vi.fn();
    renderRow(
      userRow({
        requestId: "req-2",
        resolvedAt: 5_000,
        resolvedByMessageId: "reply-9",
      }),
      scroller,
    );

    const line = screen.getByTestId("conversation-request");
    expect(line.getAttribute("data-request-state")).toBe("resolved");
    expect(within(line).getByText("Resolved")).toBeTruthy();

    const link = screen.getByTestId("conversation-request-reply-link");
    expect(link.textContent).toBe("See reply");
    expect(scroller).not.toHaveBeenCalled();
    await user.click(link);
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller).toHaveBeenCalledWith("reply-9");
  });

  it("shows Resolved with no link when the surface provides no scroller", () => {
    renderRow(
      userRow({
        requestId: "req-3",
        resolvedAt: 5_000,
        resolvedByMessageId: "reply-9",
      }),
      null,
    );

    const line = screen.getByTestId("conversation-request");
    expect(line.getAttribute("data-request-state")).toBe("resolved");
    expect(within(line).getByText("Resolved")).toBeTruthy();
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("shows Resolved with no link when no reply row is named", () => {
    renderRow(
      userRow({
        requestId: "req-4",
        resolvedAt: 5_000,
        resolvedByMessageId: null,
      }),
      vi.fn(),
    );

    expect(
      screen
        .getByTestId("conversation-request")
        .getAttribute("data-request-state"),
    ).toBe("resolved");
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });

  it("draws the sender's picture on a user row that carries one, and none on a row that does not", () => {
    renderRow(
      { ...userRow(undefined), senderAvatarUrl: "https://avatars/tess.png" },
      null,
    );
    expect(screen.getByTestId("chat-sender-avatar")).toBeTruthy();
    cleanup();

    renderRow(userRow(undefined), null);
    expect(screen.queryByTestId("chat-sender-avatar")).toBeNull();
  });

  it("renders no request line for a user row without a conversation request", () => {
    renderRow(userRow(undefined), vi.fn());

    expect(screen.getByText("User message 0")).toBeTruthy();
    expect(screen.queryByTestId("conversation-request")).toBeNull();
    expect(screen.queryByTestId("conversation-request-reply-link")).toBeNull();
  });
});

describe("useRenderedMessages conversation request", () => {
  const CONTENT: JsonContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Please review" }] },
    ],
  };

  const displayContext: RenderedMessagesDisplayContext = {
    resolveUserSenderLabel: () => "You",
    resolveUserSenderAvatarUrl: () => null,
    resolveAgentSenderDisplay: () => ({
      senderLabel: "Claude",
      providerLabel: "Claude Code",
      modelLabel: null,
    }),
    resolveAgentReasoningLabel: () => null,
    resolveAgentServiceTierLabel: () => null,
    contentBlocksPreview: () => "",
  };

  function userMessage(
    messageId: string,
    conversationRequest: ConversationRequest | undefined,
  ): Extract<Message, { role: "user" }> {
    const base: Extract<Message, { role: "user" }> = {
      role: "user",
      messageId,
      sender: { type: "user", userId: "owner-1" },
      message: { kind: "user", content: CONTENT, browserAnnotations: [] },
      timestamp: 1_000,
      sessionAnchor: null,
    };
    return conversationRequest === undefined
      ? base
      : { ...base, conversationRequest };
  }

  function renderRows(messages: ReadonlyArray<Message>) {
    const input = renderInput(messages);
    return renderHook(() => useRenderedMessages(input, displayContext));
  }

  function renderInput(
    messages: ReadonlyArray<Message>,
  ): RenderedMessagesInput {
    return {
      epicId: "epic-1",
      ownerId: "owner-1",
      ownerKind: "chat",
      viewTabId: "tab-1",
      messages,
      events: [],
      rowContext: {},
      setupCardWindows: [],
      pendingUserMessages: [],
      withdrawnMessageId: null,
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
    };
  }

  it("carries the persisted row's conversationRequest onto the rendered user row", () => {
    const request: ConversationRequest = {
      requestId: "req-1",
      resolvedAt: 7_000,
      resolvedByMessageId: "reply-1",
    };
    const { result } = renderRows([userMessage("m-open", request)]);

    const row = result.current.find((candidate) => candidate.id === "m-open");
    expect(row?.role).toBe("user");
    expect(row?.conversationRequest).toEqual(request);
  });

  it("carries the sender's picture onto a user row, and leaves the key absent when there is none", () => {
    const pictured = renderHook(() =>
      useRenderedMessages(renderInput([userMessage("m-pic", undefined)]), {
        ...displayContext,
        resolveUserSenderAvatarUrl: (sender) =>
          sender.type === "user"
            ? `https://avatars/${sender.userId}.png`
            : null,
      }),
    );
    expect(
      pictured.result.current.find((row) => row.id === "m-pic")
        ?.senderAvatarUrl,
    ).toBe("https://avatars/owner-1.png");

    const { result } = renderRows([userMessage("m-plain", undefined)]);
    const row = result.current.find((candidate) => candidate.id === "m-plain");
    expect(row !== undefined && "senderAvatarUrl" in row).toBe(false);
  });

  it("leaves the key absent on a row that opened no request", () => {
    const { result } = renderRows([userMessage("m-plain", undefined)]);

    const row = result.current.find((candidate) => candidate.id === "m-plain");
    expect(row).toBeDefined();
    expect(row !== undefined && "conversationRequest" in row).toBe(false);
  });
});
