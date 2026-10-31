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
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
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
