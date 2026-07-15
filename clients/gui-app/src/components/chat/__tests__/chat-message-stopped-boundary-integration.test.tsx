import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ReactNode } from "react";
import type {
  AgentSender,
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import {
  ChatMessage,
  type ChatMessageAssistantActions,
} from "@/components/chat/chat-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";

/**
 * Both round-2 review bugs (wrong empty-branch variant, 1ms-short duration
 * anchor) only surfaced once the hook's synthesized boundary row was actually
 * rendered through `ChatMessage`/`AssistantMessageBody` - the hook-only tests
 * in `rendered-messages.test.tsx` verify the row's fields, and the
 * component-only tests in `chat-message-assistant-body.test.tsx` verify
 * rendering from hand-built props, but neither composes the two. These tests
 * close that gap.
 */

function render(ui: ReactNode) {
  return rtlRender(
    <TooltipProvider delayDuration={0}>
      <ChatExpansionTestProviders tileInstanceId="stopped-boundary-integration-tile">
        {ui}
      </ChatExpansionTestProviders>
    </TooltipProvider>,
  );
}

let restoreClipboardMock = () => undefined;

afterEach(() => {
  restoreClipboardMock();
  restoreClipboardMock = () => undefined;
  cleanup();
});

interface ClipboardMock {
  readonly writeText: Mock<(value: string) => Promise<void>>;
}

function installClipboardMock(): ClipboardMock {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn((_value: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText },
  });
  restoreClipboardMock = () => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
      return;
    }
    Object.defineProperty(navigator, "clipboard", descriptor);
  };
  return { writeText };
}

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
};

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const BINDING = {
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat",
  viewTabId: "tab-1",
} satisfies Pick<
  RenderedMessagesInput,
  "epicId" | "ownerId" | "ownerKind" | "viewTabId"
>;

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

function userMessage(messageId: string): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT },
    timestamp: 1000,
    sessionAnchor: null,
  };
}

function assistantMessage(
  turnId: string,
  startedAt: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: turnId,
    sender: ASSISTANT_SENDER,
    blocks: [],
    startedAt,
    timestamp: startedAt,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function textBlock(
  blockId: string,
  timestamp: number,
  text: string,
): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp,
    text,
    providerNotice: null,
  };
}

function steerBlock(
  blockId: string,
  messageId: string,
  timestamp: number,
): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    blockId,
    status: "completed",
    timestamp,
    type: "steer",
    queueItemId: `queue:${blockId}`,
    messageId,
    content: CONTENT,
    mode: "safe_point",
    sender: null,
  };
}

function turnStoppedEvent(turnId: string, timestamp: number): ChatEvent {
  return {
    eventId: `event:turn.stopped:${turnId}:${timestamp}`,
    type: "turn.stopped",
    timestamp,
    clientActionId: null,
    actor: null,
    message: "Stop requested by owner.",
    turnId,
    messageId: "m1",
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "warning",
    metadata: { reason: "Stop requested by owner." },
  };
}

const FORK_ACTION: ChatMessageAssistantActions = {
  type: "assistant",
  fork: { enabled: true, pending: false, onFork: () => undefined },
};

describe("Stopped-turn boundary row: hook -> ChatMessage -> AssistantMessageBody", () => {
  it('renders "Stopped before responding" from a settled event with no assistant record', () => {
    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1")],
          events: [turnStoppedEvent("turn-pre-setup", 10_500)],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const assistantRow = result.current.find((row) => row.role === "assistant");
    if (assistantRow === undefined) {
      throw new Error("expected an event-only stopped assistant boundary");
    }

    render(
      <ChatMessage
        message={assistantRow}
        actions={null}
        backgroundToolBlockIds={new Set()}
        nextStepActions={null}
      />,
    );

    expect(
      screen.getByRole("status", { name: "Stopped before responding" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Stopped ·/ })).toBeNull();
  });

  it('renders "Stopped · {whole-turn elapsed}" plus unchanged copy/fork controls for a [text, steer] stopped turn that DID produce output', () => {
    const clipboard = installClipboardMock();
    const assistant = {
      ...assistantMessage("turn-1", 10_000),
      timestamp: 13_000,
      blocks: [
        textBlock("block-1", 11_000, "Working on it"),
        steerBlock("block-2", "steer-msg-1", 13_000),
      ],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistant],
          events: [turnStoppedEvent("turn-1", 13_000)],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const assistantRows = result.current.filter(
      (row) => row.role === "assistant",
    );
    expect(assistantRows).toHaveLength(2);

    render(
      <>
        {assistantRows.map((row) => (
          <ChatMessage
            key={row.id}
            message={row}
            actions={FORK_ACTION}
            backgroundToolBlockIds={new Set()}
            nextStepActions={null}
          />
        ))}
      </>,
    );

    // The turn's true duration (13_000 - 10_000 = 3000ms) renders as "3s" -
    // exactly the boundary this test guards: the pre-fix ordering-only
    // `startedAt + 1` anchor made this "2s" (formatWorkedFor floors seconds).
    const footer = screen.getByTestId("assistant-elapsed-footer");
    expect(footer.textContent).toBe("Stopped · 3s");
    expect(
      footer.querySelector('[data-testid="assistant-stop-badge"]'),
    ).not.toBeNull();
    expect(footer.querySelector("span.text-destructive")?.textContent).toBe(
      "Stopped",
    );
    expect(
      screen.queryByTestId("assistant-stopped-before-responding"),
    ).toBeNull();
    expect(screen.getByTestId("assistant-fork-chat")).not.toBeNull();

    // The copy control renders on the boundary row (its own segments are
    // empty) and copies the turn's actual assistant text, sourced from the
    // text chunk above the steer bubble.
    const copyButton = screen.getByTestId("assistant-reply-copy");
    fireEvent.click(copyButton);
    expect(clipboard.writeText).toHaveBeenCalledWith("Working on it");
  });

  it('renders "Stopped before responding" for a [steer]-only stopped turn with no output anywhere', () => {
    const assistant = {
      ...assistantMessage("turn-1", 10_000),
      timestamp: 10_500,
      blocks: [steerBlock("block-1", "steer-msg-1", 10_500)],
    };

    const { result } = renderHook(() =>
      useRenderedMessages(
        {
          messages: [userMessage("m1"), assistant],
          events: [turnStoppedEvent("turn-1", 10_500)],
          pendingUserMessages: [],
          liveAssistantMessage: null,
          activeTurn: null,
          runStatus: "idle",
          ...BINDING,
        },
        displayContext,
      ),
    );

    const assistantRows = result.current.filter(
      (row) => row.role === "assistant",
    );
    expect(assistantRows).toHaveLength(1);

    render(
      <ChatMessage
        message={assistantRows[0]}
        actions={FORK_ACTION}
        backgroundToolBlockIds={new Set()}
        nextStepActions={null}
      />,
    );

    const note = screen.getByTestId("assistant-stopped-before-responding");
    expect(note.textContent).toBe("Stopped before responding");
    expect(note.classList.contains("text-destructive")).toBe(true);
    expect(
      note.querySelector('[data-testid="assistant-stop-badge"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });
});
