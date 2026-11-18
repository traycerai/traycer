/**
 * On a touch screen a bot channel's rows show no actions at rest (Tracy Bots,
 * decision 176): a long press of a finger or a pen on a member's post opens
 * a sheet instead, offering Reply and "Create thread" and, on a message the
 * bot failed to answer, Retry and Edit. Driven through the real
 * `<ChatMessage>`.
 * That the floating actions neither show nor take a tap on a touch screen is
 * computed style, held by `browser-tests/bot-channel-row-actions.spec.ts`.
 */
import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRequest } from "@traycer/protocol/persistence/epic/messages";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  ChatBotPresentationContext,
  type ChatBotFailedRequest,
  type ChatBotPresentation,
  type ChatBotThreadLine,
  type ChatBotTurnReceipt,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatMessage } from "@/components/chat/chat-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LONG_PRESS_MS } from "@/hooks/ui/use-long-press";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

// The row sheet re-asserts the app theme where it portals; the provider is
// not under test.
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();
const POST_ID = "post-1";
const POST_TEXT = "Please review the release";
const OPEN_REQUEST: ConversationRequest = {
  requestId: "req-failed",
  resolvedAt: null,
  resolvedByMessageId: null,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function presentation(
  threadLine: (postMessageId: string) => ChatBotThreadLine | null,
  openThread: ((postMessageId: string) => void) | null,
  failedRequest: ChatBotPresentation["failedRequest"],
): ChatBotPresentation {
  return {
    botTitle: "Release Bot",
    threadLine,
    openThread,
    openAnnouncementThread: null,
    threadAnchorKinds: [],
    chooseOption: null,
    reply: null,
    questions: null,
    failedRequest,
    failedRecovery: null,
    replyReceipt: null,
    requestReceipt: null,
  };
}

function plain(
  openThread: ((postMessageId: string) => void) | null,
): ChatBotPresentation {
  return presentation(() => null, openThread, null);
}

function failedRequestOf(
  retry: (text: string) => void,
  retrying: boolean,
  edit: (text: string) => void,
): ChatBotFailedRequest {
  return {
    state: "failed",
    summary: "Your Grok CLI version (1.0.5) is outdated.",
    signIn: null,
    update: null,
    updating: false,
    updateFailure: null,
    retry,
    retrying,
    edit,
  };
}

function failing(
  failed: ChatBotFailedRequest,
  openThread: ((postMessageId: string) => void) | null,
): ChatBotPresentation {
  return presentation(
    () => null,
    openThread,
    (requestId) => (requestId === OPEN_REQUEST.requestId ? failed : null),
  );
}

/** A presentation whose rows reply through `reply`. */
function replying(
  value: ChatBotPresentation,
  reply: ChatBotPresentation["reply"],
): ChatBotPresentation {
  return { ...value, reply };
}

function memberPost(
  conversationRequest: ConversationRequest | undefined,
): ChatMessageModel {
  const base: ChatMessageModel = {
    ...makeMessage(0, "user"),
    persistentMessageId: POST_ID,
    senderLabel: "Tess Teammate",
    content: POST_TEXT,
    segments: [
      {
        id: "message-0:text",
        kind: "text",
        markdown: POST_TEXT,
        isStreaming: false,
      },
    ],
  };
  return conversationRequest === undefined
    ? base
    : { ...base, conversationRequest };
}

function mountRow(message: ChatMessageModel, value: ChatBotPresentation): void {
  function Providers(props: { readonly children: ReactNode }) {
    return (
      <StrictMode>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <ChatBotPresentationContext.Provider value={value}>
              {props.children}
            </ChatBotPresentationContext.Provider>
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

function renderRow(
  message: ChatMessageModel,
  value: ChatBotPresentation,
): HTMLElement {
  mountRow(message, value);
  return screen.getByTestId("bot-member-row");
}

/** A finger, or a pen, held on the row past the long-press delay. */
function longPress(row: HTMLElement, pointerType: "touch" | "pen"): void {
  vi.useFakeTimers();
  fireEvent.pointerDown(row, {
    pointerId: 1,
    pointerType,
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS);
  });
  vi.useRealTimers();
}

describe("<ChatMessage /> a member's post in a bot channel on a touch screen", () => {
  it("opens no sheet on a tap", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    const row = renderRow(memberPost(undefined), plain(openThread));

    await user.click(row);

    expect(screen.queryByTestId("bot-reply-sheet")).toBeNull();
    expect(openThread).not.toHaveBeenCalled();
  });

  it("opens the post's thread from the sheet a long press opens, and closes the sheet", async () => {
    const user = userEvent.setup();
    const openThread = vi.fn<(postMessageId: string) => void>();
    const row = renderRow(memberPost(undefined), plain(openThread));

    longPress(row, "touch");

    const choice = await screen.findByTestId("bot-reply-sheet-thread");
    expect(choice.textContent).toBe("Create thread");
    expect(screen.queryByTestId("bot-reply-sheet-retry")).toBeNull();
    expect(screen.queryByTestId("bot-reply-sheet-edit")).toBeNull();
    await user.click(choice);

    expect(openThread).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledWith(POST_ID);
    await waitFor(() => {
      expect(screen.queryByTestId("bot-reply-sheet")).toBeNull();
    });
  });

  it("opens the sheet on a pen's long press as on a finger's", async () => {
    const row = renderRow(memberPost(undefined), plain(vi.fn()));

    longPress(row, "pen");

    expect(await screen.findByTestId("bot-reply-sheet-thread")).toBeTruthy();
  });
});

describe("<ChatMessage /> a message the bot failed to answer on a touch screen", () => {
  it("offers Retry and Edit in the long-press sheet, each handing over the message's own text and closing the sheet", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<(text: string) => void>();
    const edit = vi.fn<(text: string) => void>();
    const row = renderRow(
      memberPost(OPEN_REQUEST),
      failing(failedRequestOf(retry, false, edit), vi.fn()),
    );

    longPress(row, "touch");
    await user.click(await screen.findByTestId("bot-reply-sheet-retry"));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(POST_TEXT);
    expect(edit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("bot-reply-sheet")).toBeNull();
    });

    longPress(row, "touch");
    await user.click(await screen.findByTestId("bot-reply-sheet-edit"));

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(POST_TEXT);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("holds the sheet's Retry while the retry is running", async () => {
    const retry = vi.fn<(text: string) => void>();
    const row = renderRow(
      memberPost(OPEN_REQUEST),
      failing(failedRequestOf(retry, true, vi.fn()), vi.fn()),
    );

    longPress(row, "touch");

    const choice = await screen.findByTestId("bot-reply-sheet-retry");
    expect(choice.hasAttribute("disabled")).toBe(true);
    expect(retry).not.toHaveBeenCalled();
  });

  it("still takes a long press where there is no thread to open, offering Retry and Edit and no thread action", async () => {
    const row = renderRow(
      memberPost(OPEN_REQUEST),
      failing(failedRequestOf(vi.fn(), false, vi.fn()), null),
    );

    longPress(row, "touch");

    const sheet = await screen.findByTestId("bot-reply-sheet");
    expect(within(sheet).getByTestId("bot-reply-sheet-retry")).toBeTruthy();
    expect(within(sheet).getByTestId("bot-reply-sheet-edit")).toBeTruthy();
    expect(within(sheet).queryByTestId("bot-reply-sheet-thread")).toBeNull();
  });

  it("keeps the thread line under a post with replies and the inline Not answered line", () => {
    renderRow(
      memberPost(OPEN_REQUEST),
      presentation(
        () => ({
          participants: [],
          replyCount: 2,
          lastReplyAt: Date.now() - 5 * 60_000,
          unread: false,
          unreadCount: 0,
          replying: false,
          followedUnwritten: false,
          newReplies: false,
        }),
        vi.fn(),
        (requestId) =>
          requestId === OPEN_REQUEST.requestId
            ? failedRequestOf(vi.fn(), false, vi.fn())
            : null,
      ),
    );

    expect(
      within(screen.getByTestId("bot-thread-line")).getByText("2 replies"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("bot-message-unanswered")).getByTestId(
        "bot-message-unanswered-retry",
      ),
    ).toBeTruthy();
  });
});

describe("<ChatMessage /> Reply on a touch screen", () => {
  const BOT_ROW_ID = "reply-row-1";

  function botReplyRow(): ChatMessageModel {
    return {
      ...makeMessage(1, "assistant"),
      persistentMessageId: BOT_ROW_ID,
      content: "The bot says hello\nand a second line",
      segments: [
        {
          id: "message-1:text",
          kind: "text",
          markdown: "The bot says hello\nand a second line",
          isStreaming: false,
        },
      ],
    };
  }

  it("lists Reply and Create thread after Retry and Edit in the long-press sheet of a failed message", async () => {
    const row = renderRow(
      memberPost(OPEN_REQUEST),
      replying(
        failing(failedRequestOf(vi.fn(), false, vi.fn()), vi.fn()),
        vi.fn(),
      ),
    );

    longPress(row, "touch");

    const sheet = await screen.findByTestId("bot-reply-sheet");
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["Retry", "Edit", "Reply", "Create thread"]);
  });

  it("names the message in its box from the sheet's Reply, with the row's writer and text, and closes the sheet", async () => {
    const user = userEvent.setup();
    const reply = vi.fn<NonNullable<ChatBotPresentation["reply"]>>();
    const openThread = vi.fn<(postMessageId: string) => void>();
    const row = renderRow(
      memberPost(undefined),
      replying(plain(openThread), reply),
    );

    longPress(row, "touch");
    await user.click(await screen.findByTestId("bot-reply-sheet-reply"));

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      messageId: POST_ID,
      author: "Tess Teammate",
      line: POST_TEXT,
    });
    expect(openThread).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("bot-reply-sheet")).toBeNull();
    });
  });

  it("reads Open thread in the sheet once the post's thread is listed", async () => {
    const row = renderRow(
      memberPost(undefined),
      presentation(
        () => ({
          participants: [],
          replyCount: 0,
          lastReplyAt: null,
          unread: false,
          unreadCount: 0,
          replying: false,
          followedUnwritten: false,
          newReplies: false,
        }),
        vi.fn(),
        null,
      ),
    );

    longPress(row, "touch");

    expect(
      (await screen.findByTestId("bot-reply-sheet-thread")).textContent,
    ).toBe("Open thread");
  });

  it("offers Reply alone in the sheet of a row where no thread opens", async () => {
    const row = renderRow(
      memberPost(undefined),
      replying(plain(null), vi.fn()),
    );

    longPress(row, "touch");

    const sheet = await screen.findByTestId("bot-reply-sheet");
    expect(within(sheet).getByTestId("bot-reply-sheet-reply")).toBeTruthy();
    expect(within(sheet).queryByTestId("bot-reply-sheet-thread")).toBeNull();
  });

  it("offers no sheet on a row that can neither reply nor open a thread", () => {
    const row = renderRow(memberPost(undefined), plain(null));

    longPress(row, "touch");

    expect(screen.queryByTestId("bot-reply-sheet")).toBeNull();
  });

  it("opens the sheet on the bot's row for its receipt alone, where it can neither reply nor open a thread", async () => {
    const receipt: ChatBotTurnReceipt = {
      summary: "Read 1 file",
      startedAt: 0,
      endedAt: 80_000,
      open: vi.fn(),
    };
    mountRow(botReplyRow(), { ...plain(null), replyReceipt: () => receipt });

    longPress(screen.getByTestId("bot-reply-row"), "touch");

    const sheet = await screen.findByTestId("bot-reply-sheet");
    expect(
      within(sheet).getByTestId("bot-reply-sheet-receipt").textContent,
    ).toBe("How Release Bot answered · Read 1 file · 1m 20s");
    expect(within(sheet).queryByTestId("bot-reply-sheet-reply")).toBeNull();
    expect(within(sheet).queryByTestId("bot-reply-sheet-thread")).toBeNull();
  });

  it("names the bot by its title when the sheet's Reply is chosen on its row", async () => {
    const user = userEvent.setup();
    const reply = vi.fn<NonNullable<ChatBotPresentation["reply"]>>();
    mountRow(botReplyRow(), replying(plain(null), reply));

    longPress(screen.getByTestId("bot-reply-row"), "touch");
    await user.click(await screen.findByTestId("bot-reply-sheet-reply"));

    expect(reply).toHaveBeenCalledWith({
      messageId: BOT_ROW_ID,
      author: "Release Bot",
      line: "The bot says hello",
    });
  });
});
