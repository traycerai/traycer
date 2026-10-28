/**
 * A channel the host has not created yet (Tracy Bots T57): a host that makes
 * the channel chat only on its first post closes the channel's subscribe
 * with `CHAT_NOT_VISIBLE`. The REAL `BotChatTranscript` draws that as the
 * empty channel with its intro, and re-subscribes once a send to the channel
 * succeeds - read from the real mutation cache, where the composer's
 * `bot.conversation.send` lands. Only the session store and the virtualised
 * list are stand-ins.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import { botMutationKeys } from "@/lib/query-keys/bot-mutation-keys";

type TranscriptState = Pick<
  ChatSessionState,
  | "snapshotLoaded"
  | "messages"
  | "events"
  | "transcriptRowContext"
  | "transcriptDerived"
  | "pendingUserMessages"
  | "queue"
  | "turnInProgress"
  | "messageDelivery"
  | "liveAssistantMessage"
  | "activeTurn"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "runStatus"
  | "transcriptWindow"
  | "transcriptBaselineEpoch"
  | "transcriptHydrationSequence"
  | "coldRewrittenMessageIds"
  | "backgroundItems"
  | "reportVisibleTranscriptRange"
  | "requestFindReadOrdinal"
  | "requestTranscriptOrdinal"
  | "fatalClose"
  | "retry"
>;

const mocks = vi.hoisted(() => ({
  handle: null as ChatSessionStoreHandle | null,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => mocks.handle,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
}));
vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: (props: { messages: ReadonlyArray<unknown> }) => (
    <div data-testid="chat-messages-stub" data-rows={props.messages.length} />
  ),
}));

import {
  BotChatTranscript,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT_ID = "conversation-app";

const NOT_ON_HOST: FatalErrorDetails = {
  code: "CHAT_NOT_VISIBLE",
  reason: "The chat is not on this host.",
  incompatibleMethods: null,
  upgradeGuidance: null,
  retryable: false,
};

const CHANNEL_SURFACE: BotTranscriptSurface = {
  kind: "channel",
  threadLine: () => null,
  openThread: null,
  openAnnouncementThread: null,
  chooseOption: null,
  failedRequest: () => null,
  intro: { botTitle: "Release Bot", directive: null },
};

let retry: Mock<() => void>;
let store: UseBoundStore<StoreApi<TranscriptState>>;
let queryClient: QueryClient;

/**
 * The transcript over a fresh session handle. `unmount` takes the view away
 * as switching the tab's panel does, and `remount` brings it back over the
 * same handle, which the session registry retains in between.
 */
function mountTranscript(surface: BotTranscriptSurface): {
  readonly unmount: () => void;
  readonly remount: () => void;
} {
  store = create<TranscriptState>()(() => ({
    snapshotLoaded: false,
    messages: [],
    events: [],
    transcriptRowContext: {},
    transcriptDerived: null,
    pendingUserMessages: [],
    queue: { status: "idle", items: [] },
    turnInProgress: undefined,
    messageDelivery: null,
    liveAssistantMessage: null,
    activeTurn: null,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    runStatus: "idle",
    transcriptWindow: emptyTranscriptWindow(),
    transcriptBaselineEpoch: 0,
    transcriptHydrationSequence: 0,
    coldRewrittenMessageIds: new Set<string>(),
    backgroundItems: undefined,
    reportVisibleTranscriptRange: vi.fn(),
    requestFindReadOrdinal: vi.fn(),
    requestTranscriptOrdinal: vi.fn(),
    fatalClose: NOT_ON_HOST,
    retry,
  }));
  mocks.handle = { store } as ChatSessionStoreHandle;
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <BotChatTranscript
        botId={BOT_ID}
        chatId={CHAT_ID}
        hostId="host-1"
        title="Tracy"
        instanceId="bot-channel:test"
        surface={surface}
        resolveMember={UNRESOLVED_BOT_MEMBERS}
        showConnecting
      />
    </QueryClientProvider>
  );
  let view = render(tree);
  return {
    unmount: () => view.unmount(),
    remount: () => {
      view = render(tree);
    },
  };
}

/** A `bot.conversation.send` to `conversationId` that succeeds, through the mutation cache. */
async function sendSucceeded(
  conversationId: string,
): Promise<{ readonly evict: () => void }> {
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: botMutationKeys.conversationSend(),
    mutationFn: () => Promise.resolve({ messageId: "m-1" }),
  });
  await act(async () => {
    await mutation.execute({ botId: BOT_ID, conversationId, text: "hi" });
  });
  // The cache dropping it, as its garbage collection does once unobserved.
  return { evict: () => queryClient.getMutationCache().remove(mutation) };
}

beforeEach(() => {
  // The mutation cache tells its observers on a timer by default; synchronous
  // here, so a send has reached the transcript when its `act` returns.
  notifyManager.setScheduler((notify) => notify());
  retry = vi.fn<() => void>();
  queryClient = new QueryClient();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  notifyManager.setScheduler(defaultScheduler);
  mocks.handle = null;
});

describe("<BotChatTranscript /> on a channel the host has not created yet", () => {
  it("shows the empty channel with its intro, not the stream's failure", () => {
    mountTranscript(CHANNEL_SURFACE);

    expect(screen.getByTestId("bot-channel-intro").textContent).toContain(
      "This is the beginning of your channel with Release Bot.",
    );
    expect(screen.queryByTestId("chat-messages-stub")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it("re-subscribes once a send to the channel succeeds, and shows the channel when the subscribe lands", async () => {
    mountTranscript(CHANNEL_SURFACE);

    await sendSucceeded("another-conversation");
    expect(retry).not.toHaveBeenCalled();

    await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(1);

    act(() => {
      store.setState({ fatalClose: null, snapshotLoaded: true });
    });
    expect(screen.queryByRole("status")).toBeNull();
    // The landed snapshot has no rows yet, so the recovered transcript opens
    // with the same intro, now inside the transcript itself.
    expect(screen.queryByTestId("bot-channel-not-here-yet")).toBeNull();
    expect(
      within(screen.getByTestId("bot-chat-transcript")).getByTestId(
        "bot-channel-intro",
      ),
    ).toBeTruthy();
  });

  it("re-subscribes again on a later send when the first re-subscribe still found no chat", async () => {
    mountTranscript(CHANNEL_SURFACE);
    await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(1);

    // The retry clears the close, and the host closes the new stream again.
    act(() => {
      store.setState({ fatalClose: null });
    });
    act(() => {
      store.setState({ fatalClose: NOT_ON_HOST });
    });
    expect(retry).toHaveBeenCalledTimes(1);

    await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes for a send that landed while the subscription was still connecting, once the close arrives", async () => {
    mountTranscript(CHANNEL_SURFACE);
    // Connecting: no close yet, and no snapshot.
    act(() => {
      store.setState({ fatalClose: null });
    });
    await sendSucceeded(CHAT_ID);
    expect(retry).not.toHaveBeenCalled();

    act(() => {
      store.setState({ fatalClose: NOT_ON_HOST });
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("owes nothing for a send the live channel already showed", async () => {
    mountTranscript(CHANNEL_SURFACE);
    act(() => {
      store.setState({ fatalClose: null, snapshotLoaded: true });
    });
    await sendSucceeded(CHAT_ID);

    act(() => {
      store.setState({ fatalClose: NOT_ON_HOST, snapshotLoaded: false });
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not take a send the cache drops for a new one", async () => {
    mountTranscript(CHANNEL_SURFACE);
    const first = await sendSucceeded(CHAT_ID);
    const second = await sendSucceeded(CHAT_ID);
    expect(retry).toHaveBeenCalledTimes(2);

    act(() => second.evict());
    act(() => first.evict());
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("re-subscribes once on coming back to the closed channel for a send that succeeded while it was away", async () => {
    const view = mountTranscript(CHANNEL_SURFACE);
    act(() => view.unmount());

    await sendSucceeded(CHAT_ID);
    expect(retry).not.toHaveBeenCalled();

    act(() => view.remount());
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => view.unmount());
    act(() => view.remount());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("still re-subscribes on return when the cache dropped the send that succeeded while the channel was away", async () => {
    const view = mountTranscript(CHANNEL_SURFACE);
    act(() => view.unmount());

    const sent = await sendSucceeded(CHAT_ID);
    act(() => sent.evict());

    act(() => view.remount());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("leaves a thread's close to the thread's own view", () => {
    mountTranscript({
      kind: "thread",
      chooseOption: null,
      failedRequest: () => null,
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("chat-messages-stub")).toBeTruthy();
  });
});
