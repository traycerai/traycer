import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { create, type StoreApi } from "zustand";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import type { ReplyRow } from "@/lib/voice/focused-replies";
import { MOVED_ASK_TEXT } from "@/lib/voice/say-loop";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import { VoiceSessionController } from "../voice-session-controller";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface ChatState {
  readonly snapshotLoaded: boolean;
  readonly messages: ReadonlyArray<ReplyRow>;
}

interface ConnectInput {
  readonly exchangeSdp: (offer: string) => Promise<string>;
  readonly events: VoiceEngineEvents;
}

interface FakeEngine {
  events: VoiceEngineEvents | null;
  readonly started: Deferred<void>;
  readonly connect: Mock<(input: ConnectInput) => Promise<void>>;
  readonly appendCommentary: Mock<
    (text: string, delegationId: string | null) => void
  >;
  readonly appendThinking: Mock<(text: string, delegationId: string) => void>;
  readonly close: Mock<() => Promise<void>>;
}

const BOT_ID = "bot-1";
const CHANNEL_ID = "chan-1";
const CHANNEL_FOCUS: VoiceFocus = {
  botId: BOT_ID,
  hostId: "host-a",
  threadId: null,
  anchorMessageId: null,
};

const fake = vi.hoisted(() => {
  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }
  const track = { kind: "audio", enabled: true, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  return {
    deferred,
    track,
    stream,
    micAccess: deferred<string>(),
    media: deferred<typeof stream>(),
    send: deferred<unknown>(),
    sendMock: vi.fn(),
    markRead: vi.fn(),
    setVoiceSessionLive: vi.fn(),
    endVoiceSession: vi.fn(),
    engines: [] as FakeEngine[],
    handles: new Map<string, { store: StoreApi<ChatState> }>(),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    requestMicrophoneAccess: () => fake.micAccess.promise,
    onSystemSuspended: () => ({ dispose: () => undefined }),
    setVoiceSessionLive: fake.setVoiceSessionLive,
  }),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => ({
    mintVoiceSession: () =>
      Promise.resolve({
        kind: "ok",
        session: {
          voiceSessionId: "vs1",
          answerSdp: "a",
          expiresAt: Date.now() + 7_200_000,
        },
      }),
    endVoiceSession: fake.endVoiceSession,
  }),
  useHostClient: () => null,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const BOT_LIST = {
  data: {
    bots: [
      {
        botId: "bot-1",
        environmentId: "env-1",
        title: "CI bot",
        appConversationChatId: "chan-1",
      },
    ],
  },
};
const CONVERSATION_LIST = {
  data: {
    conversations: [
      {
        conversationId: "chan-1",
        botId: "bot-1",
        title: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
};
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => BOT_LIST,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => CONVERSATION_LIST,
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({ mutateAsync: fake.sendMock }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: fake.markRead }),
  }),
);
vi.mock("@/hooks/voice/use-voice-availability-query", () => ({
  useVoiceAvailabilityQuery: () => ({ data: true }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (_epicId: string, chatId: string) =>
    fake.handles.get(chatId) ?? null,
}));
vi.mock("@/lib/voice/gpt-live-engine", () => ({
  createBrowserGptLiveEngine: () => {
    const engine: FakeEngine = {
      events: null,
      started: fake.deferred<void>(),
      connect: vi.fn<(input: ConnectInput) => Promise<void>>(async (input) => {
        engine.events = input.events;
        await input.exchangeSdp("offer");
        await engine.started.promise;
      }),
      appendCommentary: vi.fn(),
      appendThinking: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    };
    fake.engines.push(engine);
    return engine;
  },
}));
vi.mock("@/lib/voice/audio-level", () => ({
  watchAudioLevel: () => ({ stop: () => undefined }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

const initialVoice = useVoiceSessionStore.getState();
const initialRail = useBotOpenThreadStore.getState();
const initialTabs = useTabsStore.getState();
const initialBotTabs = useBotTabsStore.getState();

function textBlock(text: string): OpenTextBlock {
  return {
    blockId: `block-${text}`,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    type: "text",
    text,
    providerNotice: null,
  };
}

function botRow(messageId: string, text: string): ReplyRow {
  return {
    role: "assistant",
    messageId,
    timestamp: Date.now(),
    blocks: [textBlock(text)],
  };
}

/** A member row whose request `requestId` was resolved by the bot row `resolvedBy`. */
function requestRow(
  messageId: string,
  requestId: string,
  resolvedBy: string,
): ReplyRow {
  return {
    role: "user",
    messageId,
    timestamp: Date.now(),
    conversationRequest: {
      requestId,
      resolvedAt: Date.now(),
      resolvedByMessageId: resolvedBy,
    },
  };
}

/** The person picks `botId`'s tab: the real tab stores the selection sync reads. */
function selectBotTab(botId: string): void {
  act(() => {
    useBotTabsStore
      .getState()
      .openBotTab({ botId, hostId: "host-a", title: botId });
    useTabsStore.setState({
      items: [
        { kind: "tab", id: `item-${botId}`, ref: { kind: "bot", id: botId } },
      ],
      activeItemId: `item-${botId}`,
    });
  });
}

function addChat(chatId: string, state: ChatState): StoreApi<ChatState> {
  const store = create<ChatState>()(() => state);
  fake.handles.set(chatId, { store });
  return store;
}

function eventsOf(index: number): VoiceEngineEvents {
  const events = fake.engines[index]?.events ?? null;
  if (events === null) throw new Error(`engine ${index} was never connected`);
  return events;
}

/** Lets the promise chains the controller awaits settle, under fake timers. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function startTalk(): Promise<void> {
  const driver = useVoiceSessionStore.getState().driver;
  if (driver === null) throw new Error("the controller mounted no driver");
  act(() => driver.start());
  await settle();
}

async function grantMicrophone(): Promise<void> {
  await act(async () => {
    fake.micAccess.resolve("granted");
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function openMicrophone(): Promise<void> {
  await act(async () => {
    fake.media.resolve(fake.stream);
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function startEngine(index: number): Promise<void> {
  await act(async () => {
    fake.engines[index]?.started.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function bringLive(): Promise<void> {
  await startTalk();
  await grantMicrophone();
  await openMicrophone();
  await startEngine(0);
  expect(useVoiceSessionStore.getState().phase).toBe("live");
}

function focusOn(focus: VoiceFocus): void {
  act(() => useVoiceSessionStore.getState().setFocus(focus));
}

/** Says `text` and closes the utterance with delegation `delegationId`. */
async function say(text: string, delegationId: string): Promise<void> {
  await act(async () => {
    eventsOf(0).onInputTranscriptDelta(text);
    eventsOf(0).onDelegationCreated(delegationId);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const ACCEPTED = {
  messageId: "m1",
  requestId: "r1",
  delivery: "written",
  threadId: "t1",
};

function renderController(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <VoiceSessionController />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.micAccess = fake.deferred<string>();
  fake.media = fake.deferred<typeof fake.stream>();
  fake.send = fake.deferred<unknown>();
  fake.engines.length = 0;
  fake.handles.clear();
  fake.track.stop.mockClear();
  fake.setVoiceSessionLive.mockReset();
  fake.setVoiceSessionLive.mockImplementation(() => Promise.resolve());
  fake.endVoiceSession.mockReset();
  fake.endVoiceSession.mockImplementation(() =>
    Promise.resolve({ kind: "ok", closedAt: 1 }),
  );
  fake.sendMock.mockReset();
  fake.sendMock.mockImplementation(() => fake.send.promise);
  fake.markRead.mockReset();
  useVoiceSessionStore.setState(initialVoice, true);
  useVoiceSessionStore.getState().setAvailability("live");
  useBotOpenThreadStore.setState(initialRail, true);
  useTabsStore.setState(initialTabs, true);
  useBotTabsStore.setState(initialBotTabs, true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => fake.media.promise },
  });
  vi.stubGlobal(
    "Audio",
    class {
      autoplay = false;
      srcObject: unknown = null;
      play = () => Promise.resolve();
      pause = () => undefined;
    },
  );
  renderController();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pagehide", () => {
  it("during startup ends the session, so the microphone opened afterwards is closed and no engine connects", async () => {
    await startTalk();
    await grantMicrophone();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await openMicrophone();

    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.track.stop).toHaveBeenCalled();
    expect(fake.engines).toEqual([]);
    expect(fake.setVoiceSessionLive.mock.lastCall).toEqual([false]);
  });

  it("on a live session stops capture, ends the voice session and clears the shell flag", async () => {
    await bringLive();
    expect(fake.setVoiceSessionLive.mock.lastCall).toEqual([true]);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await settle();

    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.track.stop).toHaveBeenCalled();
    expect(fake.endVoiceSession).toHaveBeenCalledWith("vs1");
    expect(fake.setVoiceSessionLive.mock.lastCall).toEqual([false]);
  });
});

describe("an answer in a thread this session opened", () => {
  it("is spoken under its delegation from the thread's first snapshot, and the thread is marked read once said", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: false, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await say("Merge it.", "d1");
    await act(async () => {
      fake.send.resolve(ACCEPTED);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useVoiceSessionStore.getState().focus?.threadId).toBe("t1");

    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [botRow("a1", "Merged.")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("Merged."),
      "d1",
    );

    act(() => eventsOf(0).onOutputTranscriptDelta("CI bot says merged"));
    expect(fake.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "t1",
    });
  });

  it("is placed by the channel's resolved opening request when the thread holds only the reply", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await say("Merge it.", "d1");
    await act(async () => {
      fake.send.resolve(ACCEPTED);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useVoiceSessionStore.getState().focus?.threadId).toBe("t1");

    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [
          {
            role: "user",
            messageId: "m1",
            timestamp: Date.now(),
            conversationRequest: {
              requestId: "r1",
              resolvedAt: Date.now(),
              resolvedByMessageId: "a1",
            },
          },
        ],
      });
    });
    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [botRow("a1", "Merged.")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fake.engines[0]?.appendCommentary).toHaveBeenCalledTimes(1);
    expect(fake.engines[0]?.appendCommentary).toHaveBeenCalledWith(
      expect.stringContaining("Merged."),
      "d1",
    );
  });
});

describe("an engine re-mint during a send", () => {
  it("lets the accepted post complete as pending work of the continuing session", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await say("Merge it.", "d1");
    expect(useVoiceSessionStore.getState().pendingDelegationId).toBe("d1");

    act(() => eventsOf(0).onClosed("vendor"));
    await settle();
    expect(fake.engines).toHaveLength(2);
    await startEngine(1);
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    await act(async () => {
      fake.send.resolve(ACCEPTED);
      await vi.advanceTimersByTimeAsync(0);
    });

    const state = useVoiceSessionStore.getState();
    expect(state.pendingDelegationId).toBeNull();
    expect(state.focus?.threadId).toBe("t1");
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]?.kind).toBe(
      "thread",
    );
  });
});

describe("an interruption whose ask is never delivered", () => {
  it("resolves itself after the ask's three unconfirmed appends, so the next request posts", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    // The say loop exists from the session's first delegation.
    await say("Merge it.", "d0");
    await act(async () => {
      fake.send.resolve({ ...ACCEPTED, threadId: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    fake.sendMock.mockClear();

    act(() => eventsOf(0).onInputTranscriptDelta("Run"));
    selectBotTab("bot-2");
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "asking",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });

    const asks = (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(
      ([text]) => text === MOVED_ASK_TEXT,
    );
    expect(asks).toHaveLength(3);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();

    await say("Run the new build.", "d1");

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-2", text: "Run the new build." }),
    );
  });
});

describe("an ask given up during an utterance", () => {
  it("fences the utterance under way through its boundary, then posts a fresh request", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    const askCount = (): number =>
      (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(
        ([text]) => text === MOVED_ASK_TEXT,
      ).length;

    act(() => eventsOf(0).onInputTranscriptDelta("Delete "));
    selectBotTab("bot-2");
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "asking",
    );

    // Each unconfirmed append spends its confirm window; stop at the third.
    for (let step = 0; step < 400 && askCount() < 3; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(askCount()).toBe(3);
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "asking",
    );

    // Just before the third window ends the person is still mid-utterance.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_900);
    });
    act(() => eventsOf(0).onInputTranscriptDelta("the branch."));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "closing",
    );

    await act(async () => {
      eventsOf(0).onDelegationCreated("d0");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.sendMock).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();

    await say("Run the build.", "d1");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-2", text: "Run the build." }),
    );
  });
});

describe("an interruption before the session's first delegation", () => {
  it("holds the words and asks, and the first delegation posts nothing", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);

    act(() => eventsOf(0).onInputTranscriptDelta("Delete "));
    selectBotTab("bot-2");
    await say("the branch.", "d0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(fake.sendMock).not.toHaveBeenCalled();
    const asks = (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(
      ([text]) => text === MOVED_ASK_TEXT,
    );
    expect(asks).toHaveLength(1);
    const held = useVoiceSessionStore.getState().pendingAction;
    expect(held?.text).toContain("Delete");
    expect(held?.text).toContain("the branch.");
  });
});

describe("a fast answer in a cold existing thread", () => {
  const FOLLOW_UP = {
    messageId: "m1",
    requestId: "r1",
    delivery: "written",
    threadId: "t1",
  };
  const THREAD_FOCUS: VoiceFocus = { ...CHANNEL_FOCUS, threadId: "t1" };

  function coldSnapshot(): ReadonlyArray<ReplyRow> {
    return [
      botRow("h0", "Old news about the release."),
      requestRow("u1", "r1", "a1"),
      botRow("a1", "Merged."),
    ];
  }

  async function expectOneAnswer(): Promise<void> {
    const commentary = fake.engines[0]?.appendCommentary;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("Merged."),
      "d1",
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("CI bot says merged"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
  }

  it("is spoken when the snapshot beats the send's acceptance, and the history in it is not", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: false, messages: [] });
    await bringLive();
    focusOn(THREAD_FOCUS);
    await say("Update it.", "d1");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);

    act(() => {
      thread.setState({ snapshotLoaded: true, messages: coldSnapshot() });
    });
    await act(async () => {
      fake.send.resolve(FOLLOW_UP);
      await vi.advanceTimersByTimeAsync(0);
    });

    await expectOneAnswer();
  });

  it("is spoken when the acceptance comes first", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: false, messages: [] });
    await bringLive();
    focusOn(THREAD_FOCUS);
    await say("Update it.", "d1");

    await act(async () => {
      fake.send.resolve(FOLLOW_UP);
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      thread.setState({ snapshotLoaded: true, messages: coldSnapshot() });
    });

    await expectOneAnswer();
  });
});

describe("a follow-up accepted in an existing thread", () => {
  it("labels its reply with the delegation once the channel names the request, and not an unrelated row", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn({ ...CHANNEL_FOCUS, threadId: "t1" });
    await say("Follow up.", "d-new");
    await act(async () => {
      fake.send.resolve({
        messageId: "m2",
        requestId: "r-new",
        delivery: "written",
        threadId: "t1",
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    // The reply and an unrelated bot row land before the channel resolves
    // the request; the acknowledgement still holds the voice.
    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [
          botRow("a2", "Deployment finished."),
          botRow("ax", "Unrelated chatter here."),
        ],
      });
    });
    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).not.toHaveBeenCalled();

    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [requestRow("m2", "r-new", "a2")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenLastCalledWith(
      expect.stringContaining("Deployment finished."),
      "d-new",
    );

    act(() =>
      eventsOf(0).onOutputTranscriptDelta("CI bot says deployment finished"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(2);
    expect(commentary).toHaveBeenLastCalledWith(
      expect.stringContaining("Unrelated chatter here."),
      null,
    );
    act(() =>
      eventsOf(0).onOutputTranscriptDelta("CI bot says unrelated chatter"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(commentary).toHaveBeenCalledTimes(2);
  });
});

describe("a reply and its acknowledgement in a warm existing thread", () => {
  const THREAD_FOCUS: VoiceFocus = { ...CHANNEL_FOCUS, threadId: "t1" };
  const FOLLOW_UP = {
    messageId: "m1",
    requestId: "r1",
    delivery: "written",
    threadId: "t1",
  };
  const HISTORY = botRow("h0", "Old news about the release.");

  async function holdSend(): Promise<StoreApi<ChatState>> {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: true, messages: [HISTORY] });
    await bringLive();
    focusOn(THREAD_FOCUS);
    await settle();
    await say("Update it.", "d1");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    return thread;
  }

  function publishReply(thread: StoreApi<ChatState>): void {
    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [
          HISTORY,
          requestRow("u1", "r1", "a1"),
          botRow("a1", "Merged."),
        ],
      });
    });
  }

  async function acknowledge(): Promise<void> {
    await act(async () => {
      fake.send.resolve(FOLLOW_UP);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function expectOneAnswerUnderDelegation(): Promise<void> {
    const commentary = fake.engines[0]?.appendCommentary;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("Merged."),
      "d1",
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("CI bot says merged"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(fake.markRead).toHaveBeenCalledTimes(1);
    expect(fake.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "t1",
    });
  }

  it("keeps the delegation when the reply lands before the acknowledgement", async () => {
    const thread = await holdSend();
    publishReply(thread);
    await acknowledge();

    await expectOneAnswerUnderDelegation();
  });

  it("keeps the delegation when the acknowledgement lands before the reply", async () => {
    const thread = await holdSend();
    await acknowledge();
    publishReply(thread);

    await expectOneAnswerUnderDelegation();
  });
});

describe("a channel announcement queued before a later top-level request", () => {
  it("stays unlabelled, and the request's actual answer takes its delegation", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await settle();
    // Playback holds the scheduler, so the announcement is queued, not
    // appended; it answers no request (the host's announce path).
    act(() => eventsOf(0).onOutputTranscriptDelta("Working on it."));
    const announcement = botRow("ann", "The earlier task finished.");
    act(() => {
      channel.setState({ snapshotLoaded: true, messages: [announcement] });
    });
    await say("Start another build.", "d1");
    await act(async () => {
      fake.send.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: null,
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [
          announcement,
          requestRow("u1", "r1", "a2"),
          botRow("a2", "The new build is complete."),
        ],
      });
    });
    const commentary = fake.engines[0]?.appendCommentary;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("earlier task finished"),
      null,
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("the earlier task finished"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(commentary).toHaveBeenLastCalledWith(
      expect.stringContaining("new build is complete"),
      "d1",
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("the new build is complete"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(commentary).toHaveBeenCalledTimes(2);
  });
});
