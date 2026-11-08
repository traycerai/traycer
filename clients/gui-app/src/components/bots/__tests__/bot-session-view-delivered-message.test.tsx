/**
 * A bot's session holding the member message a delivery carried (Tracy Bots
 * T159): the REAL `BotSessionView` over the REAL transcript, reading scripted
 * session stores. An `autonomous_resume` trigger that names a conversation
 * message draws that message - writer, time, text, image, and a link back -
 * in place of its card; a trigger that names none keeps its card; a message
 * that cannot be read still says who wrote it and when.
 */
import { StrictMode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AutonomousResumeConversationMessage,
  AutonomousResumeTrigger,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  /** What `useChatLocateRowAnswer` answers a cold fetch of a row. */
  locate: { status: "waiting" } as
    | { status: "waiting" }
    | { status: "missing" },
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => mocks.locate,
}));

import { BotSessionView } from "@/components/bots/bot-session-view";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  POST_ID,
  POST_REQUEST,
  THREAD_ID,
  THREAD_SESSION_ID,
  memberPost,
  postThread,
  scriptedSession,
  sessionTurn,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import {
  BotMentionsContext,
  type BotMentionDirectory,
} from "@/components/bots/bot-mentions-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

const SENDER_ID = "user-teammate";
const THREAD_MESSAGE_ID = "thread-message-1";
const IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MESSAGE_TEXT = /Ship the release today,/;
const POSTED_AT = Date.UTC(2026, 10, 7, 9, 30);

/** What the bot tab hands its content to draw a mention as a chip. */
const MENTIONS: BotMentionDirectory = {
  person: (userId) =>
    userId === SENDER_ID ? { name: "Tess Teammate", self: false } : null,
  bots: [],
  tasks: [],
  tasksAnswered: true,
};

const resolveMember: BotMemberResolver = (userId) =>
  userId === SENDER_ID
    ? { displayName: "Tess Teammate", avatarUrl: null }
    : null;

/** The delivery as the host stamps it: a thread message or the thread's post. */
function delivered(
  overrides: Partial<AutonomousResumeConversationMessage>,
): AutonomousResumeConversationMessage {
  return {
    conversationId: THREAD_ID,
    messageId: THREAD_MESSAGE_ID,
    requestId: "req-delivered",
    senderUserId: SENDER_ID,
    postedAt: POSTED_AT,
    ...overrides,
  };
}

function resumeTrigger(
  conversationMessage: AutonomousResumeConversationMessage | null,
): AutonomousResumeTrigger {
  return {
    kind: "command",
    title:
      conversationMessage === null ? "Shell finished" : "Thread message: hi",
    status: "completed",
    summary: "delivered",
    blockId: "trigger-block",
    outputFile: null,
    mcp: null,
    live: false,
    managedCommand: null,
    conversationMessage,
  };
}

function resumeBlock(trigger: AutonomousResumeTrigger): ContentBlock {
  return {
    type: "autonomous_resume",
    blockId: "resume-1",
    status: "completed",
    timestamp: 2_000,
    deliveryPlacement: "turn_start",
    triggers: [trigger],
  };
}

/** The person's message with a mention, a line of text and an image. */
function personMessage(messageId: string): Extract<Message, { role: "user" }> {
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Ship the release today, <@user-teammate>?" },
          {
            type: "imageAttachment",
            attrs: {
              id: "release-image",
              fileName: "release-train.png",
              mimeType: "image/png",
              b64content: IMAGE,
            },
          },
        ],
      },
    ],
  };
  const base = memberPost({
    messageId,
    requestId: POST_REQUEST,
    lines: [],
    timestamp: POSTED_AT,
    resolvedBy: null,
  });
  return {
    ...base,
    sender: { type: "user", userId: SENDER_ID },
    message: { kind: "user", content, browserAnnotations: [] },
  };
}

const opened = {
  channel: vi.fn<(messageId: string | null) => void>(),
  thread: vi.fn<(threadId: string, messageId: string | null) => void>(),
};

/** The thread's session, holding one turn that opens with `trigger`'s resume block. */
function mountThreadSession(trigger: AutonomousResumeTrigger): void {
  const turn = sessionTurn({
    messageId: "turn-record",
    turnId: "turn-1",
    startedAt: 2_000,
    endedAt: 3_000,
    costUsd: 0.01,
  });
  mocks.sessions[THREAD_SESSION_ID] = scriptedSession(THREAD_SESSION_ID, [
    { ...turn, blocks: [resumeBlock(trigger), ...turn.blocks] },
  ]).handle;
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotIdentityContext value={IDENTITY}>
            <BotMentionsContext value={MENTIONS}>
              <BotSessionView
                botId={BOT_ID}
                hostId={HOST_ID}
                botTitle="Release Bot"
                session={{
                  chatId: THREAD_SESSION_ID,
                  threadId: THREAD_ID,
                  landOn: null,
                }}
                threads={[postThread()]}
                resolveMember={resolveMember}
                onClose={vi.fn()}
                onOpenChannel={opened.channel}
                onOpenThread={opened.thread}
              />
            </BotMentionsContext>
          </BotIdentityContext>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

beforeEach(() => {
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  mocks.locate = { status: "waiting" };
  mocks.sessions = {};
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
});

describe("a bot's session holding a delivered member message", () => {
  it("draws a thread message with its writer, time, text and image, and opens the thread landed on it", async () => {
    mocks.sessions[THREAD_ID] = scriptedSession(THREAD_ID, [
      personMessage(THREAD_MESSAGE_ID),
    ]).handle;
    mountThreadSession(resumeTrigger(delivered({})));
    await settleLegendList();

    const message = within(view()).getByTestId("bot-delivered-message");
    expect(within(message).getByText("Tess Teammate")).not.toBeNull();
    expect(within(message).getByText(MESSAGE_TEXT)).not.toBeNull();
    expect(within(message).getByTestId("bot-mention").textContent).toBe(
      "@Tess Teammate",
    );
    expect(
      within(message).getByRole("img", { name: "release-train.png" }),
    ).toHaveProperty("src", `data:image/png;base64,${IMAGE}`);
    expect(within(message).getByRole("time")).not.toBeNull();
    expect(within(view()).queryByText("Thread message: hi")).toBeNull();

    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(within(message).getByRole("button", { name: "in the thread" }));

    expect(opened.thread).toHaveBeenCalledExactlyOnceWith(
      THREAD_ID,
      THREAD_MESSAGE_ID,
    );
    expect(opened.channel).not.toHaveBeenCalled();
  });

  it("draws the channel post a thread answers and opens the channel landed on it", async () => {
    mocks.sessions[CHANNEL_ID] = scriptedSession(CHANNEL_ID, [
      personMessage(POST_ID),
    ]).handle;
    mountThreadSession(
      resumeTrigger(
        delivered({ conversationId: CHANNEL_ID, messageId: POST_ID }),
      ),
    );
    await settleLegendList();

    const message = within(view()).getByTestId("bot-delivered-message");
    expect(within(message).getByText(MESSAGE_TEXT)).not.toBeNull();

    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(within(message).getByRole("button", { name: "in the channel" }));

    expect(opened.channel).toHaveBeenCalledExactlyOnceWith(POST_ID);
    expect(opened.thread).not.toHaveBeenCalled();
  });

  it("keeps a trigger that names no message as its card", async () => {
    mountThreadSession(resumeTrigger(null));
    await settleLegendList();

    expect(within(view()).queryByTestId("bot-delivered-message")).toBeNull();
    expect(within(view()).getByText("Shell finished")).not.toBeNull();
  });

  it("keeps the card of a trigger stored before the key existed, which has no conversationMessage at all", async () => {
    const stored = resumeTrigger(null);
    Reflect.deleteProperty(stored, "conversationMessage");
    mountThreadSession(stored);
    await settleLegendList();

    expect(within(view()).queryByTestId("bot-delivered-message")).toBeNull();
    expect(within(view()).getByText("Shell finished")).not.toBeNull();
  });

  it("names the writer and the time, and says the message is unavailable, when the row cannot be read", async () => {
    mocks.locate = { status: "missing" };
    mocks.sessions[THREAD_ID] = scriptedSession(THREAD_ID, []).handle;
    mountThreadSession(resumeTrigger(delivered({})));
    await settleLegendList();

    const message = within(view()).getByTestId("bot-delivered-message");
    expect(within(message).getByText("Tess Teammate")).not.toBeNull();
    expect(within(message).getByRole("time")).not.toBeNull();
    expect(
      within(message).getByTestId("bot-delivered-post-stand-in").textContent,
    ).toBe("Message unavailable");
    expect(within(message).queryByText(MESSAGE_TEXT)).toBeNull();
  });
});
