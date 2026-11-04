import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
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
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import type {
  BotActivity,
  BotOpenResponse,
  BotRecord,
  BotSessionActivity,
} from "@traycer/protocol/host/bot/schemas";
import { botPausedCopy } from "@/components/bots/bot-tab-open-state";
import {
  CALL_HOLD_DELAY_MS,
  CALL_HOLD_LINE,
  callFailureLine,
  callUnreachableLine,
} from "@/lib/voice/call";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import type { ReplyRow } from "@/lib/voice/focused-replies";
import {
  INPUT_ACTIVE_WINDOW_MS,
  OUTPUT_HANGOVER_WITHOUT_LEVEL_MS,
} from "@/lib/voice/scheduler";
import {
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";
import { CallController } from "../call-controller";

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
  readonly connect: Mock<(input: ConnectInput) => Promise<void>>;
  readonly appendCommentary: Mock<
    (text: string, delegationId: string | null) => void
  >;
  readonly close: Mock<() => Promise<void>>;
}

const BOT_ID = "bot-1";
const HOST_ID = "host-a";
const CHANNEL_ID = "chan-1";
const BOT_TITLE = "CI bot";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-1",
  createdByUserId: "user-1",
  title: BOT_TITLE,
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-bot-1",
  boundHostId: HOST_ID,
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "direct",
  appConversationChatId: CHANNEL_ID,
};

const BOT_LIST = { data: { bots: [BOT] } };
const ENVIRONMENT_LIST = {
  data: { environments: [{ environmentId: "env-1", label: "Personal" }] },
};
const CONVERSATION_LIST = {
  data: {
    conversations: [
      {
        conversationId: CHANNEL_ID,
        botId: BOT_ID,
        title: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
};

const fake = vi.hoisted(() => {
  const order: string[] = [];
  // A track is an event target, as the real one is: the controller listens
  // for the OS taking the microphone away.
  const track = Object.assign(new EventTarget(), {
    kind: "audio",
    enabled: true,
    stop: vi.fn<() => void>(),
  });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  // The bot's activity as `useBotActivity` reads it: `null` until a test says.
  let activityValue: BotActivity | null = null;
  const activityListeners = new Set<() => void>();
  const activity = {
    get: (): BotActivity | null => activityValue,
    subscribe: (listener: () => void): (() => void) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    set: (value: BotActivity | null): void => {
      activityValue = value;
      for (const listener of activityListeners) listener();
    },
  };
  const engines: FakeEngine[] = [];
  const handles = new Map<string, { store: StoreApi<ChatState> }>();
  return {
    order,
    track,
    stream,
    activity,
    engines,
    handles,
    requestMicrophoneAccess: vi.fn<() => Promise<string>>(),
    getUserMedia: vi.fn<() => Promise<typeof stream>>(),
    mint: vi.fn<
      (request: { offerSdp: string; input: string }) => Promise<unknown>
    >(),
    endVoiceSession: vi.fn<(id: string) => Promise<unknown>>(),
    sendMock:
      vi.fn<
        (
          request: BotConversationSendRequest,
        ) => Promise<BotConversationSendResponse>
      >(),
    openMock: vi.fn<(request: { botId: string }) => Promise<BotOpenResponse>>(),
    markRead: vi.fn<(input: { epicId: string; chatId: string }) => void>(),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    requestMicrophoneAccess: fake.requestMicrophoneAccess,
    onSystemSuspended: () => ({ dispose: () => undefined }),
    setVoiceSessionLive: () => Promise.resolve(),
    setVoiceSessionIndicator: () => Promise.resolve(),
    onVoiceTrayAction: () => ({ dispose: () => undefined }),
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => ({
    mintVoiceSession: fake.mint,
    endVoiceSession: fake.endVoiceSession,
  }),
  useHostClient: () => null,
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({ mutateAsync: fake.sendMock }),
  useBotOpenMutation: () => ({ mutateAsync: fake.openMock }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useBotActivity: () =>
      useSyncExternalStore(fake.activity.subscribe, fake.activity.get),
  };
});
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (_botId: string, chatId: string) =>
    fake.handles.get(chatId) ?? null,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => CONVERSATION_LIST,
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => BOT_LIST,
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ENVIRONMENT_LIST,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/voice/use-voice-availability-query", () => ({
  useVoiceAvailabilityQuery: () => ({ data: true }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({ useNotificationMarkEntityRead: () => ({ mutate: fake.markRead }) }),
);
vi.mock("@/lib/voice/gpt-live-engine", () => ({
  createBrowserGptLiveEngine: () => {
    const engine: FakeEngine = {
      events: null,
      connect: vi.fn<(input: ConnectInput) => Promise<void>>(async (input) => {
        engine.events = input.events;
        await input.exchangeSdp("offer");
      }),
      appendCommentary:
        vi.fn<(text: string, delegationId: string | null) => void>(),
      close: vi.fn<() => Promise<void>>(() => {
        fake.order.push("engine.close");
        return Promise.resolve();
      }),
    };
    fake.engines.push(engine);
    return engine;
  },
}));

const WRITTEN: BotConversationSendResponse = {
  messageId: "m1",
  requestId: "r1",
  delivery: "written",
  threadId: "t1",
};
const QUEUED: BotConversationSendResponse = { ...WRITTEN, delivery: "queued" };
const SERVE_HERE: BotOpenResponse = {
  bot: BOT,
  outcome: { kind: "serve-here", claimed: null },
};

const CHANNEL_CALL: CallTarget = { botId: BOT_ID, threadId: null };
const OPEN_THREAD_CALL: CallTarget = { botId: BOT_ID, threadId: "t-open" };

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

/** The bot's row; later rows carry later timestamps, as a watch's baseline needs. */
function botRow(messageId: string, text: string, timestamp: number): ReplyRow {
  return {
    role: "assistant",
    messageId,
    timestamp,
    blocks: [textBlock(text)],
  };
}

function loaded(messages: ReadonlyArray<ReplyRow>): ChatState {
  return { snapshotLoaded: true, messages };
}

function addChat(chatId: string, state: ChatState): StoreApi<ChatState> {
  const store = create<ChatState>()(() => state);
  fake.handles.set(chatId, { store });
  return store;
}

function sessionActivity(
  state: BotSessionActivity["state"],
): BotSessionActivity {
  return {
    state,
    startedAt: 1,
    step: null,
    requestId: "r-turn",
    reason: null,
  };
}

function threadActivity(
  threadId: string,
  state: BotSessionActivity["state"],
): BotActivity {
  return { trunk: null, threads: { [threadId]: sessionActivity(state) } };
}

function engine(): FakeEngine {
  const found = fake.engines.at(-1);
  if (found === undefined) throw new Error("no engine was created");
  return found;
}

function events(): VoiceEngineEvents {
  const found = engine().events;
  if (found === null) throw new Error("the engine was never connected");
  return found;
}

/** What the engine was given to say, as `[text, delegationId]`. */
function appends(): ReadonlyArray<readonly [string, string | null]> {
  return engine().appendCommentary.mock.calls;
}

function appendedTexts(): ReadonlyArray<string> {
  return appends().map(([text]) => text);
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets the promise chains the controller awaits settle, under fake timers. */
async function settle(): Promise<void> {
  await advance(0);
}

/** Past the longest hold any of the voice's own words puts on the next append. */
async function untilQuiet(): Promise<void> {
  await advance(OUTPUT_HANGOVER_WITHOUT_LEVEL_MS);
}

function driverOf() {
  const driver = useVoiceSessionStore.getState().driver;
  if (driver === null) throw new Error("the controller mounted no driver");
  return driver;
}

async function dial(target: CallTarget): Promise<void> {
  act(() => driverOf().start(target));
  await settle();
}

async function dialLive(target: CallTarget): Promise<void> {
  await dial(target);
  expect(useVoiceSessionStore.getState().phase).toBe("live");
}

/** The person says `deltas`; nothing closes the utterance yet. */
function speak(...deltas: ReadonlyArray<string>): void {
  act(() => {
    for (const delta of deltas) events().onInputTranscriptDelta(delta);
  });
}

/** The voice's acknowledgement begins: the utterance boundary. */
async function acknowledge(): Promise<void> {
  act(() => events().onOutputTranscriptDelta("Okay"));
  await settle();
}

async function say(...deltas: ReadonlyArray<string>): Promise<void> {
  speak(...deltas);
  await acknowledge();
}

/** The voice says `words` aloud. */
function voiceSays(words: string): void {
  act(() => events().onOutputTranscriptDelta(words));
}

/** A call joined to thread `t-open`, whose history is `history`. */
async function joinOpenThread(
  history: ReadonlyArray<ReplyRow>,
): Promise<StoreApi<ChatState>> {
  const chat = addChat("t-open", loaded(history));
  await dialLive(OPEN_THREAD_CALL);
  return chat;
}

function land(chat: StoreApi<ChatState>, rows: ReadonlyArray<ReplyRow>): void {
  act(() => chat.setState(loaded(rows)));
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.order.length = 0;
  fake.engines.length = 0;
  fake.handles.clear();
  fake.activity.set(null);
  fake.track.enabled = true;
  fake.track.stop.mockReset();
  fake.track.stop.mockImplementation(() => {
    fake.order.push("mic.stop");
  });
  fake.requestMicrophoneAccess.mockReset();
  fake.requestMicrophoneAccess.mockImplementation(() =>
    Promise.resolve("granted"),
  );
  fake.getUserMedia.mockReset();
  fake.getUserMedia.mockImplementation(() => Promise.resolve(fake.stream));
  fake.mint.mockReset();
  fake.mint.mockImplementation(() =>
    Promise.resolve({
      kind: "ok",
      session: {
        voiceSessionId: "vs1",
        answerSdp: "answer",
        expiresAt: Date.now() + 7_200_000,
      },
    }),
  );
  fake.endVoiceSession.mockReset();
  fake.endVoiceSession.mockImplementation(() => {
    fake.order.push("end-route");
    return Promise.resolve({ kind: "ok", closedAt: 1 });
  });
  fake.sendMock.mockReset();
  fake.sendMock.mockImplementation(() => Promise.resolve(WRITTEN));
  fake.openMock.mockReset();
  fake.openMock.mockImplementation(() => Promise.resolve(SERVE_HERE));
  fake.markRead.mockReset();
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: fake.getUserMedia },
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CallController />
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the dial", () => {
  it("refuses a paused bot with its tab's own line, asking for no microphone and minting nothing", async () => {
    fake.openMock.mockImplementation(() =>
      Promise.resolve({
        bot: BOT,
        outcome: { kind: "paused", reason: "host-not-in-environment" },
      }),
    );

    await dial(CHANNEL_CALL);

    const state = useVoiceSessionStore.getState();
    expect(fake.openMock.mock.calls).toEqual([[{ botId: BOT_ID }]]);
    expect(state.phase).toBe("idle");
    expect(state.refusal).toBe("paused");
    expect(state.pausedCopy).toBe(
      botPausedCopy("host-not-in-environment", "Personal").text,
    );
    expect(state.pausedCopy).toContain("Personal");
    expect(fake.requestMicrophoneAccess).not.toHaveBeenCalled();
    expect(fake.getUserMedia).not.toHaveBeenCalled();
    expect(fake.engines).toHaveLength(0);
    expect(fake.mint).not.toHaveBeenCalled();
  });

  it("refuses as unavailable when the bot cannot be opened, asking for no microphone", async () => {
    fake.openMock.mockImplementation(() =>
      Promise.reject(new Error("offline")),
    );

    await dial(CHANNEL_CALL);

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.refusal).toBe("unavailable");
    expect(fake.requestMicrophoneAccess).not.toHaveBeenCalled();
    expect(fake.mint).not.toHaveBeenCalled();
  });

  it("goes live on a bot that serves, minting with no input", async () => {
    await dial(CHANNEL_CALL);

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("live");
    expect(state.refusal).toBeNull();
    expect(fake.openMock.mock.calls).toEqual([[{ botId: BOT_ID }]]);
    expect(fake.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
    expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
    expect(fake.mint.mock.calls).toEqual([[{ offerSdp: "offer", input: "" }]]);
    expect(state.focus).toEqual({
      botId: BOT_ID,
      hostId: HOST_ID,
      threadId: null,
    });
  });
});

describe("what the person says", () => {
  it("sends nothing on input alone, nor on a delegation, and one message verbatim at the boundary", async () => {
    await dialLive(CHANNEL_CALL);

    speak("Tell the CI bot", " to hold", " the build. ");
    act(() => events().onDelegationCreated("d1"));
    await settle();
    expect(fake.sendMock).not.toHaveBeenCalled();

    await acknowledge();

    expect(fake.sendMock.mock.calls).toEqual([
      [
        {
          botId: BOT_ID,
          conversationId: CHANNEL_ID,
          text: "Tell the CI bot to hold the build.",
          threadId: null,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: null,
          spoken: true,
          origin: "call",
        },
      ],
    ]);
  });

  it("binds the thread the first send opened, and sends later words into it with no origin", async () => {
    await dialLive(CHANNEL_CALL);
    await say("First thing.");
    expect(useVoiceSessionStore.getState().focus?.threadId).toBe("t1");

    await say("Second thing.");

    expect(fake.sendMock).toHaveBeenCalledTimes(2);
    const second = fake.sendMock.mock.calls[1][0];
    expect(second.threadId).toBe("t1");
    expect(second.text).toBe("Second thing.");
    expect(second.spoken).toBe(true);
    expect("origin" in second).toBe(false);
  });

  it("holds a second utterance until the first send has answered, then sends it into the bound thread", async () => {
    let answer: (response: BotConversationSendResponse) => void = () => {
      throw new Error("the first send was never made");
    };
    fake.sendMock.mockImplementationOnce(
      () =>
        new Promise<BotConversationSendResponse>((resolve) => {
          answer = resolve;
        }),
    );
    await dialLive(CHANNEL_CALL);
    await say("First thing.");
    await say("Second thing.");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);

    answer(WRITTEN);
    await settle();

    expect(fake.sendMock).toHaveBeenCalledTimes(2);
    const second = fake.sendMock.mock.calls[1][0];
    expect(second.threadId).toBe("t1");
    expect(second.text).toBe("Second thing.");
    expect("origin" in second).toBe(false);
  });

  it("sends the first words of a call started from an open thread into it, with no origin", async () => {
    addChat("t-open", loaded([]));
    await dialLive(OPEN_THREAD_CALL);

    await say("Pick this up.");

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    const request = fake.sendMock.mock.calls[0][0];
    expect(request.threadId).toBe("t-open");
    expect(request.conversationId).toBe(CHANNEL_ID);
    expect(request.spoken).toBe(true);
    expect("origin" in request).toBe(false);
  });

  it.each(["Goodbye.", "end the call", "End the call."])(
    "ends the call on the end phrase %j and sends nothing",
    async (phrase) => {
      await dialLive(CHANNEL_CALL);

      await say(phrase);

      const state = useVoiceSessionStore.getState();
      expect(state.phase).toBe("idle");
      expect(state.endReason).toBeNull();
      expect(fake.sendMock).not.toHaveBeenCalled();
      expect(fake.track.stop).toHaveBeenCalled();
      expect(engine().close).toHaveBeenCalledTimes(1);
    },
  );

  it("sends an end phrase said inside a longer request, and the call goes on", async () => {
    await dialLive(CHANNEL_CALL);

    await say("Please end the call with the vendor");

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock.mock.calls[0][0].text).toBe(
      "Please end the call with the vendor",
    );
    expect(useVoiceSessionStore.getState().phase).toBe("live");
  });

  it("appends the failure line and stays live when a send fails, and sends the next words", async () => {
    fake.sendMock.mockImplementationOnce(() =>
      Promise.reject(new Error("offline")),
    );
    await dialLive(CHANNEL_CALL);

    await say("First thing.");
    await untilQuiet();

    expect(appends()).toEqual([[callFailureLine(BOT_TITLE), null]]);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    voiceSays(callFailureLine(BOT_TITLE));
    await say("Second thing.");
    expect(fake.sendMock).toHaveBeenCalledTimes(2);
    expect(fake.sendMock.mock.calls[1][0].text).toBe("Second thing.");
  });
});

describe("a send the bot cannot take", () => {
  async function dialAndSayIntoQueued(): Promise<void> {
    fake.sendMock.mockImplementationOnce(() => Promise.resolve(QUEUED));
    await dialLive(CHANNEL_CALL);
    expect(fake.track.enabled).toBe(true);
    await say("Tell the CI bot to hold the build.");
  }

  it("switches the microphone off at once, says why, and ends unreachable once it is said", async () => {
    await dialAndSayIntoQueued();

    expect(fake.track.enabled).toBe(false);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(appends()).toEqual([]);

    await untilQuiet();
    expect(appends()).toEqual([[callUnreachableLine(BOT_TITLE), null]]);
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    voiceSays(callUnreachableLine(BOT_TITLE));

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.endReason).toBe("unreachable");
    expect(fake.track.stop).toHaveBeenCalled();
    expect(engine().close).toHaveBeenCalledTimes(1);
  });

  it("ends unreachable too when the line cannot be confirmed said", async () => {
    await dialAndSayIntoQueued();
    await untilQuiet();
    expect(appends()).toHaveLength(1);
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    await advance(60_000);

    expect(appendedTexts()).toEqual([
      callUnreachableLine(BOT_TITLE),
      callUnreachableLine(BOT_TITLE),
      callUnreachableLine(BOT_TITLE),
    ]);
    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.endReason).toBe("unreachable");
  });

  it("sends nothing that was said while the queued answer was still out", async () => {
    let answer: (response: BotConversationSendResponse) => void = () => {
      throw new Error("the first send was never made");
    };
    fake.sendMock.mockImplementationOnce(
      () =>
        new Promise<BotConversationSendResponse>((resolve) => {
          answer = resolve;
        }),
    );
    await dialLive(CHANNEL_CALL);
    await say("First thing.");
    await say("Second thing.");

    answer(QUEUED);
    await settle();
    await untilQuiet();

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.track.enabled).toBe(false);
  });

  it("neither re-sends the queued words nor sends anything said after", async () => {
    await dialAndSayIntoQueued();

    await say("Also, one more thing.");
    await untilQuiet();

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock.mock.calls[0][0].text).toBe(
      "Tell the CI bot to hold the build.",
    );
  });
});

describe("what the voice says of the bot's replies", () => {
  it("appends a new reply row once, at a clear moment, under no delegation", async () => {
    const chat = await joinOpenThread([botRow("old", "Earlier answer.", 100)]);

    land(chat, [
      botRow("old", "Earlier answer.", 100),
      botRow("new", "The build is green.", 200),
    ]);
    await settle();

    expect(appends()).toEqual([["The build is green.", null]]);
    voiceSays("The build is green.");
    await advance(10 * CALL_HOLD_DELAY_MS);
    expect(appends()).toEqual([["The build is green.", null]]);
  });

  it("does not speak the history of a thread the call joined", async () => {
    await joinOpenThread([
      botRow("h1", "Yesterday's answer.", 100),
      botRow("h2", "Another old answer.", 110),
    ]);

    await advance(60_000);

    expect(appends()).toEqual([]);
  });

  it("speaks what already answered in the thread the call's own first send opened", async () => {
    addChat("t1", loaded([botRow("a1", "Already answered.", 100)]));
    await dialLive(CHANNEL_CALL);

    await say("Is the build green?");
    await advance(OUTPUT_HANGOVER_WITHOUT_LEVEL_MS - 1);
    expect(appends()).toEqual([]);
    await advance(1);

    expect(appends()).toEqual([["Already answered.", null]]);
  });

  it("waits out the person speaking before it appends", async () => {
    const chat = await joinOpenThread([]);

    speak("Hold on a second");
    land(chat, [botRow("new", "The build is green.", 200)]);
    await advance(INPUT_ACTIVE_WINDOW_MS - 1);
    expect(appends()).toEqual([]);
    await advance(1);

    expect(appends()).toEqual([["The build is green.", null]]);
  });

  it("waits out the voice speaking before it appends", async () => {
    const chat = await joinOpenThread([]);

    voiceSays("Mm-hmm");
    land(chat, [botRow("new", "The build is green.", 200)]);
    await advance(OUTPUT_HANGOVER_WITHOUT_LEVEL_MS - 1);
    expect(appends()).toEqual([]);
    await advance(1);

    expect(appends()).toEqual([["The build is green.", null]]);
  });

  it("speaks an open question with its choices as a list", async () => {
    const chat = await joinOpenThread([]);
    const question: ReplyRow = {
      role: "assistant",
      messageId: "q-1",
      timestamp: 200,
      blocks: [textBlock("Ready to release. Ship or hold?")],
      question: {
        requestId: "req-q",
        questions: [
          {
            text: "Ship or hold?",
            options: ["Ship", "Hold"],
            allowFreeText: false,
            settlement: null,
          },
        ],
      },
    };

    land(chat, [question]);
    await settle();

    expect(appends()).toEqual([
      [
        "Ready to release. Ship or hold? The choices are: 1. Ship; 2. Hold.",
        null,
      ],
    ]);
  });

  it("marks the thread read once the reply is confirmed said, and not before", async () => {
    const chat = await joinOpenThread([]);

    land(chat, [botRow("new", "The build finished with two warnings.", 200)]);
    await settle();
    expect(fake.markRead).not.toHaveBeenCalled();

    voiceSays("The build finished with two warnings.");

    expect(fake.markRead.mock.calls).toEqual([
      [{ epicId: BOT_ID, chatId: "t-open" }],
    ]);
  });
});

describe("holding the floor while the bot works", () => {
  function holds(): number {
    return appendedTexts().filter((text) => text === CALL_HOLD_LINE).length;
  }

  it("says one hold line after the delay, and no more while the turn goes on", async () => {
    await joinOpenThread([]);

    act(() => fake.activity.set(threadActivity("t-open", "replying")));
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(appends()).toEqual([]);
    await advance(1);
    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);

    voiceSays(CALL_HOLD_LINE);
    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);
  });

  it("says nothing for a turn that is not replying", async () => {
    await joinOpenThread([]);

    act(() => fake.activity.set(threadActivity("t-open", "idle")));
    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([]);
  });

  it("waits a full delay again after a reply lands before another hold line", async () => {
    const chat = await joinOpenThread([]);
    act(() => fake.activity.set(threadActivity("t-open", "replying")));
    await advance(CALL_HOLD_DELAY_MS);
    voiceSays(CALL_HOLD_LINE);
    await advance(6_000);
    expect(holds()).toBe(1);

    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    voiceSays("Build finished with two warnings");
    expect(appendedTexts()).toContain("Build finished with two warnings");

    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(holds()).toBe(1);
    await advance(5_000);
    expect(holds()).toBe(2);
  });

  it("withdraws a hold line still waiting when a reply lands, so the reply is what is said", async () => {
    const chat = await joinOpenThread([]);
    act(() => fake.activity.set(threadActivity("t-open", "replying")));
    await advance(CALL_HOLD_DELAY_MS - 500);
    // The person is speaking when the delay runs out: the hold stays queued.
    speak("Wait, one thing");
    await advance(500);
    expect(appends()).toEqual([]);

    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await advance(INPUT_ACTIVE_WINDOW_MS);

    expect(appends()).toEqual([["Build finished with two warnings", null]]);
    await advance(CALL_HOLD_DELAY_MS - INPUT_ACTIVE_WINDOW_MS - 1);
    expect(holds()).toBe(0);
  });

  it.each(["failed", "parked"] as const)(
    "says the failure line once when the turn turns %s, and the call stays open",
    async (stopped) => {
      await joinOpenThread([]);
      act(() => fake.activity.set(threadActivity("t-open", "replying")));
      await advance(1_000);

      act(() => fake.activity.set(threadActivity("t-open", stopped)));
      await settle();
      expect(appends()).toEqual([[callFailureLine(BOT_TITLE), null]]);
      voiceSays(callFailureLine(BOT_TITLE));
      await advance(10 * CALL_HOLD_DELAY_MS);

      expect(appends()).toEqual([[callFailureLine(BOT_TITLE), null]]);
      expect(useVoiceSessionStore.getState().phase).toBe("live");
      expect(fake.endVoiceSession).not.toHaveBeenCalled();
      expect(engine().close).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "parked"] as const)(
    "says no failure line when the first reading of activity, after the call joined, already says the turn is %s",
    async (stopped) => {
      await joinOpenThread([]);

      act(() => fake.activity.set(threadActivity("t-open", stopped)));
      await advance(10 * CALL_HOLD_DELAY_MS);

      expect(appends()).toEqual([]);
    },
  );

  it("says no failure line for a turn that had already failed when the call joined the thread", async () => {
    act(() => fake.activity.set(threadActivity("t-open", "failed")));
    await joinOpenThread([]);

    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([]);
  });
});

describe("ending the call", () => {
  it("stops the microphone before closing the voice and the end route, and speaks nothing after", async () => {
    const chat = await joinOpenThread([]);
    act(() => fake.activity.set(threadActivity("t-open", "replying")));
    // A reply lands while the person is speaking: it is queued, not said.
    speak("Hang on");
    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    expect(appends()).toEqual([]);

    act(() => driverOf().end());
    await settle();

    expect(fake.order).toEqual(["mic.stop", "engine.close", "end-route"]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");

    land(chat, [
      botRow("r1", "Build finished with two warnings", 200),
      botRow("r2", "And the deploy is done", 300),
    ]);
    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([]);
    expect(fake.sendMock).not.toHaveBeenCalled();
  });

  it("leaves the bot's turn running: nothing is sent to cancel it", async () => {
    await joinOpenThread([]);
    act(() => fake.activity.set(threadActivity("t-open", "replying")));
    await say("Run the release checks.");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);

    act(() => driverOf().end());
    await settle();

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
  });
});
