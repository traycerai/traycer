/**
 * A bot's session, readable whole (Tracy Bots T93): the REAL `BotSessionView`
 * over the REAL `BotChatTranscript` and `ChatMessages`, reading a scripted
 * session store the way the tab's session registry hands it one. What a
 * reader sees is asserted as they see it: the session's rows in time order,
 * the bot's sends as cards whose links say where they landed, a question with
 * nothing to press but the way to the channel, and no box to write in. Only
 * the session registry (scripted sessions by chat id) and the host reads the
 * transcript makes beside its rows are replaced.
 */
import { StrictMode, type ReactNode } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
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
// A bot's own session draws no receipts: the transcript asks for none.
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
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
  POST_FIRST_LINE,
  POST_ID,
  REPLY_PROMPT_ID,
  THREAD_ID,
  THREAD_SESSION_ID,
  TRUNK_ID,
  buildScene,
  postThread,
  scriptedSession,
  sessionPrompt,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotTranscriptLanding } from "@/components/bots/bot-chat-transcript";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import { useTileFindStore } from "@/stores/tile-find";

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

const CHECKIN_PROMPT_ID = "prompt-checkin";
const CHECKIN_TEXT = "Check-in from nightly-audit: 2 findings";
const REPLY_TEXT = "Nightly audit: two findings, both in the pool image build.";
const QUESTION_TEXT = "Keep the old base image until the pool bump lands?";

const BOT_SENDER = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
} as const;

function sendCall(input: {
  readonly blockId: string;
  readonly toolName: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly at: number;
}): Extract<ContentBlock, { readonly type: "tool_call" }> {
  return {
    type: "tool_call",
    blockId: input.blockId,
    toolName: input.toolName,
    inputSummary: input.toolName,
    inputDetail: {
      kind: "fields",
      entries: Object.entries(input.fields).map(([key, value]) => ({
        key,
        label: key,
        value,
      })),
    },
    taskTodoItems: null,
    error: input.error,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    agentMessageDelivery: null,
    artifact: null,
    mcpApp: null,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    status: input.error === null ? "completed" : "errored",
    timestamp: input.at,
    startedAt: input.at,
    endedAt: input.at,
    imageResults: [],
  };
}

const READ_PATH = "reports/nightly-audit.md";

/** The check-in turn reading its report: activity the agent chat groups. */
function readCall(at: number): ContentBlock {
  return {
    ...sendCall({
      blockId: "read-report",
      toolName: "Read",
      fields: { file_path: READ_PATH },
      error: null,
      at,
    }),
    inputSummary: READ_PATH,
  };
}

/** A model fallback between turns, as the routing engine writes it. */
function fallbackNotice(at: number): ContentBlock {
  return {
    type: "text",
    blockId: "notice-fallback",
    status: "completed",
    timestamp: at,
    text: "Switched providers.",
    providerNotice: {
      harnessId: "claude",
      noticeKind: "fallback_applied",
      tone: "info",
      title: "Switched providers",
      message: "Moved to Codex after a rate limit.",
      details: [],
      metadata: null,
    },
  };
}

function botTurn(input: {
  readonly messageId: string;
  readonly turnId: string;
  readonly at: number;
  readonly blocks: ReadonlyArray<ContentBlock>;
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: BOT_SENDER,
    blocks: [...input.blocks],
    startedAt: input.at,
    timestamp: input.at,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function checkinPrompt(): Extract<Message, { role: "user" }> {
  const prompt = sessionPrompt(CHECKIN_PROMPT_ID, 1_000);
  return {
    ...prompt,
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: CHECKIN_TEXT }],
          },
        ],
      },
      browserAnnotations: [],
    },
  };
}

/**
 * The trunk's session: a check-in and the reply it posted under a member's
 * post, a model fallback, then a member's question and the bot's question
 * back, which follows that same post.
 */
function trunkMessages(): ReadonlyArray<Message> {
  return [
    checkinPrompt(),
    botTurn({
      messageId: "turn-checkin-record",
      turnId: "turn-checkin",
      at: 2_000,
      blocks: [
        readCall(1_500),
        sendCall({
          blockId: "send-reply",
          toolName: "mcp__traycer_a2a__traycer_reply",
          fields: {
            conversationId: CHANNEL_ID,
            text: REPLY_TEXT,
            resolvesRequestIds: "[]",
            options: JSON.stringify(["Keep it", "Bump now"]),
            repliesTo: POST_ID,
          },
          error: null,
          at: 2_000,
        }),
        fallbackNotice(2_500),
      ],
    }),
    sessionPrompt(REPLY_PROMPT_ID, 3_000),
    botTurn({
      messageId: "turn-ask-record",
      turnId: "turn-ask",
      at: 4_000,
      blocks: [
        sendCall({
          blockId: "send-ask",
          toolName: "mcp__traycer_a2a__traycer_ask",
          fields: {
            conversationId: CHANNEL_ID,
            questions: JSON.stringify([
              {
                text: QUESTION_TEXT,
                options: ["Keep it", "Bump now"],
                allowFreeText: false,
              },
            ]),
            repliesTo: POST_ID,
          },
          error: null,
          at: 4_000,
        }),
      ],
    }),
  ];
}

const opened = {
  channel: vi.fn<(messageId: string | null) => void>(),
  thread: vi.fn<(threadId: string) => void>(),
  close: vi.fn<() => void>(),
};

function mountSession(input: {
  readonly chatId: string;
  readonly threadId: string | null;
  readonly landOn: BotTranscriptLanding | null;
  readonly threads: ReadonlyArray<BotThreadSummary>;
}): void {
  const tree = (): ReactNode => (
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotIdentityContext value={IDENTITY}>
            <BotSessionView
              botId={BOT_ID}
              hostId={HOST_ID}
              botTitle="Release Bot"
              session={{
                chatId: input.chatId,
                threadId: input.threadId,
                landOn: input.landOn,
              }}
              threads={input.threads}
              resolveMember={UNRESOLVED_BOT_MEMBERS}
              onClose={opened.close}
              onOpenChannel={opened.channel}
              onOpenThread={opened.thread}
            />
          </BotIdentityContext>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  render(tree());
}

function mountTrunk(landOn: BotTranscriptLanding | null): void {
  mountSession({ chatId: TRUNK_ID, threadId: null, landOn, threads: [] });
}

/** The trunk with one check-in turn whose only block is `send`. */
function mountOneSend(send: ContentBlock): void {
  mocks.sessions[TRUNK_ID] = scriptedSession(TRUNK_ID, [
    checkinPrompt(),
    botTurn({
      messageId: "turn-send-record",
      turnId: "turn-send",
      at: 2_000,
      blocks: [send],
    }),
  ]).handle;
  mountTrunk(null);
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

function sendCards(): HTMLElement[] {
  return within(view()).getAllByTestId("bot-send-card");
}

beforeEach(() => {
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  const scene = buildScene();
  const trunk = scriptedSession(TRUNK_ID, trunkMessages());
  mocks.sessions = { ...scene.sessions, [TRUNK_ID]: trunk.handle };
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
});

describe("a bot's trunk session, read whole", () => {
  it("reads every turn and what happened between them in time order: the check-in, the reply it posted as a send, the fallback, the next prompt and the question back", async () => {
    mountTrunk(null);
    await settleLegendList();

    const text = view().textContent;
    const order = [
      CHECKIN_TEXT,
      REPLY_TEXT,
      "Switched providers",
      "A prompt the host wrote for the bot",
      QUESTION_TEXT,
    ].map((part) => text.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(within(view()).getByTestId("bot-session-title").textContent).toBe(
      "Release Bot · trunk session",
    );
  });

  it("draws the bot's reply as a send naming the channel, with its choices as they read and a link to the post it answered", async () => {
    const user = userEvent.setup();
    mountTrunk(null);
    await settleLegendList();

    const reply = sendCards().find((card) => card.dataset.kind === "reply");
    if (reply === undefined) throw new Error("no reply card");
    expect(within(reply).getByTestId("bot-send-place").textContent).toBe(
      "Replied in the channel",
    );
    expect(within(reply).getByTestId("bot-send-text").textContent).toBe(
      REPLY_TEXT,
    );
    expect(
      within(reply)
        .getAllByTestId("bot-send-option")
        .map((option) => option.textContent),
    ).toEqual(["Keep it", "Bump now"]);
    expect(within(reply).queryByRole("button", { name: "Keep it" })).toBeNull();

    await user.click(within(reply).getByRole("button", { name: "Open post" }));

    expect(opened.channel).toHaveBeenCalledWith(POST_ID);
  });

  it("draws the bot's question with nothing to press but Answer in the channel, which shows the channel at the post it follows", async () => {
    const user = userEvent.setup();
    mountTrunk(null);
    await settleLegendList();

    const ask = sendCards().find((card) => card.dataset.kind === "ask");
    if (ask === undefined) throw new Error("no question card");
    expect(within(ask).getByTestId("bot-send-question").textContent).toContain(
      QUESTION_TEXT,
    );
    expect(
      within(ask)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Answer in the channel"]);

    await user.click(
      within(ask).getByRole("button", { name: "Answer in the channel" }),
    );

    expect(opened.channel).toHaveBeenCalledWith(POST_ID);
  });

  it("offers no box to write in, says the bot is spoken to in its channel and links there, and goes back from its header", async () => {
    const user = userEvent.setup();
    mountTrunk(null);
    await settleLegendList();

    expect(within(view()).queryByRole("textbox")).toBeNull();
    const footer = within(view()).getByTestId("bot-session-footer");
    expect(footer.textContent).toBe(
      "Read-only. Release Bot is spoken to inits channel",
    );

    await user.click(
      within(footer).getByRole("button", { name: "its channel" }),
    );
    expect(opened.channel).toHaveBeenCalledWith(null);
    await user.click(within(view()).getByRole("button", { name: "Back" }));
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it("finds text in the check-in turn's activity and in what the bot posted, as the agent chat's find does", async () => {
    const user = userEvent.setup();
    mountTrunk(null);
    await settleLegendList();

    act(() => {
      useTileFindStore.getState().openForTile(`bot-session:${TRUNK_ID}`);
    });
    const bar = await within(view()).findByTestId("tile-find-bar");
    const input = within(bar).getByRole("textbox", { name: "Find in tile" });

    await user.type(input, "nightly-audit.md");
    await waitFor(() => expect(bar.textContent).toContain("1 of 1"));

    await user.clear(input);
    await user.type(input, "pool image build");
    await waitFor(() => expect(bar.textContent).toContain("1 of 1"));
  });

  it("lands on the turn it was opened on", async () => {
    mountTrunk({ messageId: REPLY_PROMPT_ID, visit: 1 });
    await settleLegendList();

    await waitFor(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-message-id="${REPLY_PROMPT_ID}"]`,
      );
      expect(row?.dataset.navigationHighlighted).toBe("true");
    });
  });

  it("leaves a send that failed as the agent chat's row, since nothing was posted", async () => {
    mocks.sessions[TRUNK_ID] = scriptedSession(TRUNK_ID, [
      checkinPrompt(),
      botTurn({
        messageId: "turn-failed-record",
        turnId: "turn-failed",
        at: 2_000,
        blocks: [
          sendCall({
            blockId: "send-refused",
            toolName: "mcp__traycer_a2a__traycer_reply",
            fields: { conversationId: CHANNEL_ID, text: REPLY_TEXT },
            error: "The conversation takes no replies.",
            at: 2_000,
          }),
        ],
      }),
    ]).handle;
    mountTrunk(null);
    await settleLegendList();

    expect(within(view()).queryByTestId("bot-send-card")).toBeNull();
    expect(view().textContent).toContain("traycer_reply");
  });

  it("names an agent's question the bot pointed at, with nothing to press but Answer in the channel", async () => {
    const user = userEvent.setup();
    mocks.sessions[TRUNK_ID] = scriptedSession(TRUNK_ID, [
      checkinPrompt(),
      botTurn({
        messageId: "turn-surface-record",
        turnId: "turn-surface",
        at: 2_000,
        blocks: [
          sendCall({
            blockId: "send-surface",
            toolName: "mcp__traycer_a2a__traycer_reply",
            fields: {
              conversationId: CHANNEL_ID,
              text: REPLY_TEXT,
              repliesTo: POST_ID,
              surface: JSON.stringify({
                kind: "question",
                taskId: "epic-1",
                hostId: HOST_ID,
                chatId: "agent-chat",
                blockId: "question-block",
              }),
            },
            error: null,
            at: 2_000,
          }),
        ],
      }),
    ]).handle;
    mountTrunk(null);
    await settleLegendList();

    const [reply] = sendCards();
    expect(within(reply).getByTestId("bot-send-surface").textContent).toBe(
      "An agent's question",
    );
    expect(
      within(reply)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Answer in the channel"]);

    await user.click(
      within(reply).getByRole("button", { name: "Answer in the channel" }),
    );

    expect(opened.channel).toHaveBeenCalledWith(POST_ID);
  });

  it("leaves a send a stop cut off as the agent chat's row, since it may not have posted", async () => {
    mountOneSend({
      ...sendCall({
        blockId: "send-interrupted",
        toolName: "mcp__traycer_a2a__traycer_reply",
        fields: { conversationId: CHANNEL_ID, text: REPLY_TEXT },
        error: null,
        at: 2_000,
      }),
      status: "interrupted",
      endedAt: null,
    });
    await settleLegendList();

    expect(within(view()).queryByTestId("bot-send-card")).toBeNull();
    expect(view().textContent).toContain("traycer_reply");
  });

  it("renders a reply's Markdown as the channel does, and finds its link and its choices as they read", async () => {
    const user = userEvent.setup();
    mountOneSend(
      sendCall({
        blockId: "send-markdown",
        toolName: "mcp__traycer_a2a__traycer_reply",
        fields: {
          conversationId: CHANNEL_ID,
          text: "Details in [the audit report](https://example.com/audit).",
          options: JSON.stringify(["Ship tonight"]),
          repliesTo: POST_ID,
        },
        error: null,
        at: 2_000,
      }),
    );
    await settleLegendList();

    const [reply] = sendCards();
    const text = within(reply).getByTestId("bot-send-text");
    expect(text.textContent).toBe("Details in the audit report.");
    expect(
      within(text).getByRole("link", { name: "the audit report" }),
    ).toBeDefined();

    act(() => {
      useTileFindStore.getState().openForTile(`bot-session:${TRUNK_ID}`);
    });
    const bar = await within(view()).findByTestId("tile-find-bar");
    const input = within(bar).getByRole("textbox", { name: "Find in tile" });
    await user.type(input, "the audit report");
    await waitFor(() => expect(bar.textContent).toContain("1 of 1"));
    await user.clear(input);
    await user.type(input, "Ship tonight");
    await waitFor(() => expect(bar.textContent).toContain("1 of 1"));
  });
});

describe("a thread's session, read whole", () => {
  it("names the thread its reply went to by the thread's post, and links to the thread", async () => {
    const user = userEvent.setup();
    mocks.sessions[THREAD_SESSION_ID] = scriptedSession(THREAD_SESSION_ID, [
      sessionPrompt("prompt-thread", 1_000),
      botTurn({
        messageId: "turn-thread-record",
        turnId: "turn-thread",
        at: 2_000,
        blocks: [
          sendCall({
            blockId: "send-thread-reply",
            toolName: "mcp__traycer_a2a__traycer_reply",
            fields: {
              conversationId: THREAD_ID,
              text: REPLY_TEXT,
              resolvesRequestIds: "[]",
              options: "null",
            },
            error: null,
            at: 2_000,
          }),
        ],
      }),
    ]).handle;
    mountSession({
      chatId: THREAD_SESSION_ID,
      threadId: THREAD_ID,
      landOn: null,
      threads: [postThread()],
    });
    await settleLegendList();

    const [reply] = sendCards();
    expect(within(view()).getByTestId("bot-session-title").textContent).toBe(
      "Release Bot · thread session",
    );
    expect(within(reply).getByTestId("bot-send-place").textContent).toBe(
      `Replied in the thread · ${POST_FIRST_LINE}`,
    );
    expect(within(reply).queryAllByTestId("bot-send-option")).toEqual([]);

    await user.click(
      within(reply).getByRole("button", { name: "Open thread" }),
    );

    expect(opened.thread).toHaveBeenCalledWith(THREAD_ID);
  });
});
