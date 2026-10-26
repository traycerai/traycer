/**
 * Where a bot channel says an error (Tracy Bots T61): in the channel or the
 * thread, never on the tab. The REAL `BotChannelView`, its thread panel, the
 * message box and the failure/notice components run over real stores; only the
 * host hooks are scripted. `bot.conversation.send` is a mutation each case
 * settles by hand (so "before the host takes it" is a call the case controls),
 * what the bot is doing reaches the view through one scripted
 * `useBotActivity`, and the virtualised transcript is a stub that exposes the
 * option pick each surface hands it.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import type { BotTranscriptSurface } from "@/components/bots/bot-chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  BotActivity,
  BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";

/** One `bot.conversation.send` the view started, settled by the case. */
interface SendCall {
  readonly variables: BotConversationSendRequest;
  readonly succeed: () => void;
  readonly fail: () => void;
}

interface SendCallbacks {
  readonly onSuccess?: (response: BotConversationSendResponse) => void;
  readonly onError: (error: HostRpcError) => void;
}

const mocks = vi.hoisted(() => ({
  client: { stub: "tab-host-client" },
  sends: [] as SendCall[],
  toastFromHostError: vi.fn<(error: Error, fallback: string) => void>(),
  state: {
    threads: [] as BotThreadSummary[],
    activity: null as BotActivity | null,
  },
}));

// The thread panel reads its post's text from the channel's session; none is
// loaded here.
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: "conversation-channel" }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.state.threads },
    isError: false,
    refetch: vi.fn(),
  }),
}));
// A send the host has not answered is pending; the case answers it, which is
// the only thing that settles it.
vi.mock("@/hooks/bots/use-bot-mutations", async () => {
  const { useCallback, useState } = await import("react");
  return {
    useBotConversationSendMutation: () => {
      const [isPending, setPending] = useState(false);
      const mutate = useCallback(
        (variables: BotConversationSendRequest, callbacks: SendCallbacks) => {
          setPending(true);
          mocks.sends.push({
            variables,
            succeed: () => {
              setPending(false);
              callbacks.onSuccess?.({
                messageId: "message-1",
                requestId: "request-1",
                delivery: "written",
                threadId: null,
              });
            },
            fail: () => {
              setPending(false);
              callbacks.onError(
                new HostRpcError({
                  code: "RPC_ERROR",
                  message: "host refused the message",
                  requestId: "req-1",
                  method: "bot.conversation.send",
                  fatalDetails: null,
                }),
              );
            },
          });
        },
        [],
      );
      return { mutate, isPending };
    },
  };
});
vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: mocks.toastFromHostError,
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/bots/use-bot-activity", () => ({
  useBotActivity: () => mocks.state.activity,
}));
vi.mock("@/components/bots/bot-chat-transcript", () => ({
  BotChatTranscript: (props: { surface: BotTranscriptSurface | null }) => {
    const { surface } = props;
    if (surface === null || surface.chooseOption === null) return null;
    return <ChoiceStub kind={surface.kind} pick={surface.chooseOption} />;
  },
}));

/** The option "Ship it" the surface offers, once per surface. */
function ChoiceStub(props: {
  readonly kind: BotTranscriptSurface["kind"];
  readonly pick: (choice: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={`stub-choose-${props.kind}`}
      onClick={() => props.pick("Ship it")}
    />
  );
}

import { BotChannelView } from "@/components/bots/bot-channel-view";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-bound";
const CHANNEL_ID = "conversation-channel";
const THREAD_ID = "thread-1";
const POST_ID = "post-1";
const SEND_FAILED = "Couldn't send. Edit and try again.";
const UNANSWERED = "Release Bot couldn't answer this. Send another message.";

const resolveMember: BotMemberResolver = () => null;

const LISTED_THREAD: BotThreadSummary = {
  threadId: THREAD_ID,
  conversationId: CHANNEL_ID,
  sessionChatId: "session-1",
  anchor: {
    messageId: POST_ID,
    requestId: "req-thread",
    senderUserId: "user-teammate",
    sentAt: 1_000,
    resolvedAt: null,
  },
  replyCount: 1,
  lastReplyAt: 2_000,
  openRequestCount: 1,
  costUsd: null,
};

const OPEN_LISTED_THREAD: BotOpenThread = {
  anchorMessageId: POST_ID,
  announcement: false,
};
const OPEN_UNOPENED_THREAD: BotOpenThread = {
  anchorMessageId: "question-1",
  announcement: true,
};

function session(
  state: BotSessionActivity["state"],
  requestId: string | null,
): BotSessionActivity {
  return { state, startedAt: 1_000, step: null, requestId };
}

function activity(
  trunk: BotSessionActivity | null,
  threads: Readonly<Record<string, BotSessionActivity>>,
): BotActivity {
  return { trunk, threads };
}

function mount(openThread: BotOpenThread | null): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ChatExpansionTestProviders tileInstanceId="tile-1">
          <BotChannelView
            botId={BOT_ID}
            hostId={HOST_ID}
            botTitle="Release Bot"
            directive={null}
            appConversationChatId={CHANNEL_ID}
            resolveMember={resolveMember}
            openThread={openThread}
            onOpenThread={vi.fn()}
            onOpenUnderTheHood={vi.fn()}
          />
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function sendAt(index: number): SendCall {
  const call = mocks.sends.at(index);
  if (call === undefined) throw new Error(`no send at ${String(index)}`);
  return call;
}

function lastSend(): SendCall {
  return sendAt(-1);
}

/** The host's answer to the send in flight. */
function settle(outcome: "succeed" | "fail"): void {
  const call = lastSend();
  act(() => {
    call[outcome]();
  });
}

async function typeAndEnter(box: HTMLElement, text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(box, `${text}{Enter}`);
}

beforeEach(() => {
  mocks.sends.length = 0;
  mocks.toastFromHostError.mockClear();
  mocks.state.threads = [];
  mocks.state.activity = null;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BotChannelView /> a message the host refuses", () => {
  it("says so in the channel with the text kept, and a second Enter sends it again as a plain send", async () => {
    mount(null);
    const box = screen.getByRole("textbox", { name: "Message #Release Bot" });
    await typeAndEnter(box, "Ship it");
    expect(mocks.sends).toHaveLength(1);

    settle("fail");

    const notice = screen.getByTestId("bot-channel-composer-send-failed");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toBe(SEND_FAILED);
    expect((box as HTMLTextAreaElement).value).toBe("Ship it");
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(box);
    await user.keyboard("{Enter}");

    expect(mocks.sends).toHaveLength(2);
    expect(sendAt(1).variables).toEqual(sendAt(0).variables);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();

    settle("succeed");

    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("takes the notice away when the person edits the text", async () => {
    mount(null);
    const box = screen.getByRole("textbox", { name: "Message #Release Bot" });
    await typeAndEnter(box, "Ship it");
    settle("fail");
    expect(screen.getByTestId("bot-channel-composer-send-failed")).toBeTruthy();

    const user = userEvent.setup();
    await user.type(box, "!");

    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe("Ship it!");
  });
});

describe("<BotChannelView /> an option pick the host refuses", () => {
  it("says so in the channel's dock, not in a toast, and a new pick clears it", async () => {
    const user = userEvent.setup();
    mount(null);

    await user.click(screen.getByTestId("stub-choose-channel"));
    expect(lastSend().variables).toEqual({
      botId: BOT_ID,
      conversationId: CHANNEL_ID,
      text: "Ship it",
      threadId: null,
      announcementId: null,
    });
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    settle("fail");

    expect(
      screen.getByTestId("bot-channel-composer-send-failed").textContent,
    ).toBe(SEND_FAILED);
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("stub-choose-channel"));

    expect(mocks.sends).toHaveLength(2);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });
});

describe("<BotChannelView /> a thread's reply the host refuses", () => {
  beforeEach(() => {
    mocks.state.threads = [LISTED_THREAD];
  });

  it("says so in the thread's dock with the text kept, and leaves the channel's box alone", async () => {
    mount(OPEN_LISTED_THREAD);
    const panel = screen.getByTestId("bot-thread-panel");
    const box = within(panel).getByRole("textbox", {
      name: "Reply in the thread",
    });

    await typeAndEnter(box, "Not yet");
    expect(lastSend().variables).toEqual({
      botId: BOT_ID,
      conversationId: CHANNEL_ID,
      text: "Not yet",
      threadId: THREAD_ID,
      announcementId: null,
    });
    settle("fail");

    expect(
      within(panel).getByTestId("bot-thread-composer-send-failed").textContent,
    ).toBe(SEND_FAILED);
    expect((box as HTMLTextAreaElement).value).toBe("Not yet");
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();
  });

  it("says a refused option pick the same way, in the thread", async () => {
    const user = userEvent.setup();
    mount(OPEN_LISTED_THREAD);

    await user.click(screen.getByTestId("stub-choose-thread"));
    expect(lastSend().variables.threadId).toBe(THREAD_ID);
    settle("fail");

    expect(
      within(screen.getByTestId("bot-thread-panel")).getByTestId(
        "bot-thread-composer-send-failed",
      ).textContent,
    ).toBe(SEND_FAILED);
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("stub-choose-thread"));

    expect(mocks.sends).toHaveLength(2);
    expect(screen.queryByTestId("bot-thread-composer-send-failed")).toBeNull();
  });

  it("says a refused first reply in a thread nobody has started the same way", async () => {
    mount(OPEN_UNOPENED_THREAD);
    const box = within(screen.getByTestId("bot-thread-panel")).getByRole(
      "textbox",
      { name: "Reply in a new thread" },
    );

    await typeAndEnter(box, "First");
    expect(lastSend().variables.announcementId).toBe("question-1");
    settle("fail");

    expect(
      screen.getByTestId("bot-thread-composer-send-failed").textContent,
    ).toBe(SEND_FAILED);
    expect((box as HTMLTextAreaElement).value).toBe("First");
    expect(mocks.toastFromHostError).not.toHaveBeenCalled();
  });
});

describe("<BotChannelView /> an answer the bot does not give", () => {
  // The host's frames: a failure keeps the post it answered, a park (a
  // delivery the host could not start) carries none, and a failure may too.
  it.each([
    ["failed", "req-1"],
    ["parked", null],
    ["failed", null],
  ] as const)(
    "says the bot couldn't answer a post it holds when its trunk is %s (request %s), with nothing to send again",
    (state, requestId) => {
      mocks.state.activity = activity(session(state, requestId), {});
      mount(null);

      const notice = screen.getByTestId("bot-channel-unanswered");
      expect(notice.textContent).toBe(UNANSWERED);
      expect(notice.getAttribute("data-state")).toBe(state);
      expect(within(notice).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
    },
  );

  it("draws the typing line and no notice while the trunk replies", () => {
    mocks.state.activity = activity(session("replying", "req-1"), {});
    mount(null);

    expect(screen.getByTestId("bot-channel-replying")).toBeTruthy();
    expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
  });

  it.each([
    ["idle", activity(session("idle", "req-1"), {})],
    ["a trunk this client cannot read", activity(null, {})],
    ["no activity at all", null],
  ])("draws neither for %s", (_name, current) => {
    mocks.state.activity = current;
    mount(null);

    expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
    expect(screen.queryByTestId("bot-channel-replying")).toBeNull();
  });
});

describe("<BotChannelView /> a thread the bot does not answer", () => {
  beforeEach(() => {
    mocks.state.threads = [LISTED_THREAD];
  });

  it.each(["parked", "failed"] as const)(
    "says so in the thread when its own session is %s",
    (state) => {
      mocks.state.activity = activity(null, {
        [THREAD_ID]: session(state, "req-thread"),
      });
      mount(OPEN_LISTED_THREAD);

      const notice = within(screen.getByTestId("bot-thread-panel")).getByTestId(
        "bot-thread-unanswered",
      );
      expect(notice.textContent).toBe(UNANSWERED);
      expect(notice.getAttribute("data-state")).toBe(state);
      expect(screen.queryByTestId("bot-channel-unanswered")).toBeNull();
    },
  );

  it("says nothing in the thread while its own session is idle, whatever the trunk is doing", () => {
    mocks.state.activity = activity(session("failed", "req-1"), {
      [THREAD_ID]: session("idle", "req-thread"),
    });
    mount(OPEN_LISTED_THREAD);

    expect(screen.queryByTestId("bot-thread-unanswered")).toBeNull();
    expect(screen.getByTestId("bot-channel-unanswered")).toBeTruthy();
  });
});
