/**
 * On a touch screen a bot channel's rows show no actions at rest (Tracy Bots,
 * decision 176): a long press of a finger or a pen on a member's post opens
 * a sheet instead, offering "Reply in thread" and, on a message the bot
 * failed to answer, Retry and Edit. Driven through the real `<ChatMessage>`.
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

function renderRow(
  message: ChatMessageModel,
  value: ChatBotPresentation,
): HTMLElement {
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

    const choice = await screen.findByTestId("bot-reply-sheet-reply-in-thread");
    expect(choice.textContent).toBe("Reply in thread");
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

    expect(
      await screen.findByTestId("bot-reply-sheet-reply-in-thread"),
    ).toBeTruthy();
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

  it("still takes a long press where there is no thread to open, offering Retry and Edit and no Reply in thread", async () => {
    const row = renderRow(
      memberPost(OPEN_REQUEST),
      failing(failedRequestOf(vi.fn(), false, vi.fn()), null),
    );

    longPress(row, "touch");

    const sheet = await screen.findByTestId("bot-reply-sheet");
    expect(within(sheet).getByTestId("bot-reply-sheet-retry")).toBeTruthy();
    expect(within(sheet).getByTestId("bot-reply-sheet-edit")).toBeTruthy();
    expect(
      within(sheet).queryByTestId("bot-reply-sheet-reply-in-thread"),
    ).toBeNull();
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
