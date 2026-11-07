import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { botConversationSendV13 } from "@traycer/protocol/host/bot/contracts";
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
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { botPausedCopy } from "@/components/bots/bot-tab-open-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import {
  CALL_HOLD_DELAY_MS,
  CALL_HOLD_LINE,
  callFailureLine,
  callUnreachableLine,
} from "@/lib/voice/call";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import type { ReplyRow } from "@/lib/voice/focused-replies";
import {
  CONFIRM_WINDOW_MS,
  INPUT_ACTIVE_WINDOW_MS,
  OUTPUT_HANGOVER_MS,
  OUTPUT_HANGOVER_WITHOUT_LEVEL_MS,
} from "@/lib/voice/scheduler";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";
import { voiceSessionsMintViaHttp } from "@traycer-clients/shared/host-client/voice-sessions";
import { CallController } from "../call-controller";

interface ChatState {
  readonly snapshotLoaded: boolean;
  readonly messages: ReadonlyArray<ReplyRow>;
}

interface FakeRemote {
  getAudioTracks(): ReadonlyArray<{ enabled: boolean }>;
}

interface ConnectInput {
  readonly exchangeSdp: (offer: string) => Promise<string>;
  readonly onRemoteAudio: (remote: FakeRemote) => void;
  readonly events: VoiceEngineEvents;
}

interface FakeEngine {
  events: VoiceEngineEvents | null;
  onRemoteAudio: ((remote: FakeRemote) => void) | null;
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
  const sendHosts: string[] = [];
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
  const remote = { getAudioTracks: () => [{ enabled: true }] };
  // The sound-level detector the voice's track is watched by, once it is up.
  const level: {
    onHealthy: ((healthy: boolean) => void) | null;
    onSpeaking: ((speaking: boolean) => void) | null;
  } = { onHealthy: null, onSpeaking: null };
  const engines: FakeEngine[] = [];
  // The `bot.conversation.send` line the host negotiated; `null` is unknown.
  const sendVersion: { current: SchemaVersion | null } = { current: null };
  const handles = new Map<string, { store: StoreApi<ChatState> }>();
  return {
    order,
    sendHosts,
    track,
    stream,
    remote,
    level,
    activity,
    engines,
    handles,
    sendVersion,
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

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
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
  // A call's send names its host; the host each went to is kept in order.
  useBotCallSendMutation: () => ({
    mutateAsync: (variables: {
      readonly hostId: string;
      readonly request: BotConversationSendRequest;
    }) => {
      fake.sendHosts.push(variables.hostId);
      return fake.sendMock(variables.request);
    },
  }),
  useBotOpenMutation: () => ({ mutateAsync: fake.openMock }),
}));
// The real activity hook runs over this stream: a host answers only the
// subscription made on it.
vi.mock("@/hooks/bots/use-bot-subscription", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useBotSubscriptionForHost: (args: {
      readonly hostId: string;
      readonly enabled: boolean;
    }) => {
      const activity = useSyncExternalStore(
        fake.activity.subscribe,
        fake.activity.get,
      );
      return {
        snapshot: args.enabled && args.hostId === HOST_ID ? { activity } : null,
        error: null,
        deleted: false,
      };
    },
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
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
  readHostMethodSchemaVersion: () => fake.sendVersion.current,
}));
vi.mock("@/hooks/voice/use-voice-availability-query", () => ({
  useVoiceAvailabilityQuery: () => ({ data: true }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({ useNotificationMarkEntityRead: () => ({ mutate: fake.markRead }) }),
);
vi.mock("@/lib/voice/audio-level", () => ({
  watchAudioLevel: (
    _stream: FakeRemote,
    onSpeaking: (speaking: boolean) => void,
    onHealthy: (healthy: boolean) => void,
  ) => {
    fake.level.onHealthy = onHealthy;
    fake.level.onSpeaking = onSpeaking;
    return { stop: () => undefined };
  },
}));
vi.mock("@/lib/voice/gpt-live-engine", () => ({
  createBrowserGptLiveEngine: () => {
    const engine: FakeEngine = {
      events: null,
      onRemoteAudio: null,
      connect: vi.fn<(input: ConnectInput) => Promise<void>>(async (input) => {
        engine.events = input.events;
        engine.onRemoteAudio = input.onRemoteAudio;
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

const TURN_REQUEST = "r-turn";

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
  requestId: string | null,
): BotSessionActivity {
  return { state, startedAt: 1, step: null, requestId, reason: null };
}

function threadActivity(
  threadId: string,
  state: BotSessionActivity["state"],
  requestId: string | null,
): BotActivity {
  return {
    trunk: null,
    threads: { [threadId]: sessionActivity(state, requestId) },
  };
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

/**
 * The voice's acknowledgement begins: the utterance boundary. Every line the
 * voice acknowledges with ends in terminal punctuation ("Okay.", "Got it.",
 * "One moment."), which is how its turn is told to be over.
 */
async function acknowledge(): Promise<void> {
  act(() => events().onOutputTranscriptDelta("Okay."));
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

/**
 * The voice's sound is up and a trusted level detector watches it: the voice
 * counts as quiet 700 ms after its last transcript fragment, not four seconds.
 */
function hearVoiceWithLevelDetection(): void {
  act(() => {
    const onRemoteAudio = engine().onRemoteAudio;
    if (onRemoteAudio === null)
      throw new Error("the engine was never connected");
    onRemoteAudio(fake.remote);
    const onHealthy = fake.level.onHealthy;
    if (onHealthy === null) throw new Error("no level detector was started");
    onHealthy(true);
  });
}

/** The voice's sound crosses the speaking threshold, or falls under it. */
function remoteSpeaking(speaking: boolean): void {
  const onSpeaking = fake.level.onSpeaking;
  if (onSpeaking === null) throw new Error("no audio detector");
  act(() => onSpeaking(speaking));
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

function mintFromHttp(lines: unknown, id: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            voiceSessionId: id,
            answerSdp: "answer",
            expiresAt: Date.now() + 7_200_000,
            acknowledgementLines: lines,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ),
  );
  fake.mint.mockImplementation((request) =>
    voiceSessionsMintViaHttp(
      "https://voice.invalid/",
      "test-bearer",
      null,
      request,
    ),
  );
}

function sentTexts(): ReadonlyArray<string> {
  return fake.sendMock.mock.calls.map(([request]) => request.text);
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.order.length = 0;
  fake.sendHosts.length = 0;
  fake.engines.length = 0;
  fake.handles.clear();
  fake.activity.set(null);
  fake.sendVersion.current = botConversationSendV13.schemaVersion;
  fake.level.onHealthy = null;
  fake.level.onSpeaking = null;
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
        acknowledgementLines: ["Okay.", "One moment.", "Got it."],
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
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  vi.stubGlobal(
    "Audio",
    class {
      autoplay = false;
      srcObject: unknown = null;
      play = () => Promise.resolve();
      pause = () => undefined;
    },
  );
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
  vi.unstubAllGlobals();
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

  it("refuses a host that negotiated a send line older than calls, asking for no microphone", async () => {
    fake.sendVersion.current = { major: 1, minor: 2 };

    await dial(CHANNEL_CALL);

    const state = useVoiceSessionStore.getState();
    expect(fake.openMock).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe("idle");
    expect(state.refusal).toBe("update");
    expect(fake.requestMicrophoneAccess).not.toHaveBeenCalled();
    expect(fake.getUserMedia).not.toHaveBeenCalled();
    expect(fake.engines).toHaveLength(0);
    expect(fake.mint).not.toHaveBeenCalled();
  });

  it("refuses as unavailable a host whose send line is not known, asking for no microphone", async () => {
    fake.sendVersion.current = null;

    await dial(CHANNEL_CALL);

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.refusal).toBe("unavailable");
    expect(fake.requestMicrophoneAccess).not.toHaveBeenCalled();
    expect(fake.engines).toHaveLength(0);
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

  it("keeps a new utterance whole when the voice's acknowledgement of the last one runs on", async () => {
    await dialLive(CHANNEL_CALL);
    speak("First request.");
    voiceSays("One");
    await settle();
    expect(fake.sendMock).not.toHaveBeenCalled();

    speak("Actually cancel");
    voiceSays(" moment.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([request]) => request.text)).toEqual([
      "First request.",
    ]);
    speak(" the release.");
    await acknowledge();

    expect(fake.sendMock.mock.calls.map(([request]) => request.text)).toEqual([
      "First request.",
      "Actually cancel the release.",
    ]);
  });

  it("does not take the start of an end phrase for a whole one when the voice's reply runs on over it", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow("r1", "The release has passed checks and is ready to ship.", 200),
    ]);
    await settle();
    voiceSays("The release has passed");
    speak("end the call");
    voiceSays(" checks");
    speak(" with the vendor tomorrow.");
    await acknowledge();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([request]) => request.text)).toEqual([
      "end the call with the vendor tomorrow.",
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

describe("the utterance boundary, told by the voice's own text", () => {
  it("sends a short follow-up acknowledged 1.9 seconds after the previous acknowledgement without a detector", async () => {
    await dialLive(CHANNEL_CALL);
    await say("First request.");
    await advance(800);
    speak("Cancel");
    await advance(200);
    speak(" that.");
    await advance(900);
    voiceSays("Okay.");
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "Cancel that.",
    ]);
  });

  it("honours an exact end phrase with a 1.9-second acknowledgement gap without a detector", async () => {
    await dialLive(CHANNEL_CALL);
    await say("First request.");
    await advance(800);
    speak("bye");
    await advance(1_100);
    voiceSays("Okay.");
    await advance(10_000);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
    ]);
  });

  it("commits the first utterance when audio starts 100 ms before its transcript arrives", async () => {
    await dialLive(CHANNEL_CALL);
    hearVoiceWithLevelDetection();
    speak("Ship the release.");
    await advance(1_000);
    remoteSpeaking(true);
    await advance(100);
    voiceSays("Okay.");
    await advance(700);
    remoteSpeaking(false);
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Ship the release.",
    ]);
  });

  it("sends a follow-up while the detector still has the previous audio's hangover", async () => {
    await dialLive(CHANNEL_CALL);
    hearVoiceWithLevelDetection();
    await say("First request.");
    remoteSpeaking(true);
    await advance(500); // Previous acknowledgement audio ends here.
    speak("No.");
    await advance(400); // Next acknowledgement transcript: 900ms after the last.
    voiceSays("Okay.");
    await advance(100); // Detector's 500ms audio hangover ends.
    remoteSpeaking(false);
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "No.",
    ]);
  });

  it("sends the person's words at once when they speak over a reply and the voice is cut off", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow("r1", "The release has passed checks and is ready to ship.", 200),
    ]);
    await settle();
    expect(appendedTexts()).toEqual([
      "The release has passed checks and is ready to ship.",
    ]);

    voiceSays("The release has passed");
    speak("Cancel the release");
    await acknowledge();

    expect(fake.sendMock.mock.calls.map(([request]) => request.text)).toEqual([
      "Cancel the release",
    ]);
  });

  it("does not hang up on unfinished input between two sentences of the same reply", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow("r1", "The build passed. The deployment is still running.", 200),
    ]);
    await settle();
    expect(appendedTexts()).toEqual([
      "The build passed. The deployment is still running.",
    ]);
    voiceSays("The build passed.");
    speak("end the call");
    voiceSays(" The deployment is still running.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("does not hang up when the previous reply's closing punctuation arrives during unfinished input", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The build passed.", 200)]);
    await settle();
    voiceSays("The build passed");
    speak("end the call");
    voiceSays(".");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("does not split an acknowledgement whose prefix equals the last given reply", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "One.", 200)]);
    await settle();
    voiceSays("One.");
    await untilQuiet();
    speak("First request.");
    voiceSays("One");
    await settle();
    speak("Actually cancel");
    voiceSays(" moment.");
    speak(" the release.");
    await acknowledge();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "Actually cancel the release.",
    ]);
  });

  it("sends the last utterance when it interrupts the first of multiple appended chunks", async () => {
    const chat = await joinOpenThread([]);
    const reply =
      "The release summary starts with " +
      "deployment status remains healthy ".repeat(80) +
      "and the rollout is complete.";
    land(chat, [botRow("r1", reply, 200)]);
    await settle();
    expect(appendedTexts().length).toBeGreaterThan(1);
    expect(appendedTexts()[0]).toMatch(/^The release summary starts with/);
    voiceSays("The release summary starts with");
    speak("Cancel the rollout.");
    await acknowledge();
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel the rollout.",
    ]);
  });

  it("does not split an input at a mid-sentence chunk transition", async () => {
    const chat = await joinOpenThread([]);
    const reply =
      "The release summary starts with " +
      "deployment status remains healthy ".repeat(80) +
      "and the rollout is complete.";
    land(chat, [botRow("r1", reply, 200)]);
    await settle();
    expect(appendedTexts().length).toBeGreaterThan(1);
    const chunks = appendedTexts();
    voiceSays(chunks[0]);
    speak("Actually cancel");
    voiceSays(chunks[1]);
    speak(" the release.");
    await acknowledge();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Actually cancel the release.",
    ]);
  });

  it("keeps reading a second reply as one turn when the voice's own acknowledgement came between the two", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The deploy finished.", 200)]);
    await settle();
    voiceSays("The deploy finished.");
    await untilQuiet();
    land(chat, [
      botRow("r1", "The deploy finished.", 200),
      botRow("r2", "The build passed. The deployment is still running.", 300),
    ]);
    await settle();
    expect(appendedTexts()).toEqual([
      "The deploy finished.",
      "The build passed. The deployment is still running.",
    ]);
    speak("Cancel that");
    voiceSays("Okay.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel that",
    ]);

    voiceSays("The build passed.");
    speak("end the call");
    voiceSays(" The deployment is still running.");
    speak(" with the vendor tomorrow.");
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    await acknowledge();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel that",
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("does not hang up when an own acknowledgement shares the pending reply prefix", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "One deployment is still running.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual(["One deployment is still running."]);
    speak("First request.");
    voiceSays("One");
    await settle();
    speak("end the call");
    voiceSays(" moment.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("keeps a merged acknowledgement tail and reading prefix from creating a false boundary", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow("r1", "The build passed. The deployment is still running.", 200),
    ]);
    await settle();
    speak("First request.");
    voiceSays("One");
    await settle();
    voiceSays(" moment. The build passed.");
    speak("end the call");
    voiceSays(" The deployment is still running.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("does not treat the first known reading delta as acknowledgement of unfinished input", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The build passed.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual(["The build passed."]);
    await advance(500);
    speak("end the call");
    await advance(100);
    voiceSays("The build");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("handles a given reply which is itself an acknowledgement", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "One moment.", 200)]);
    await settle();
    voiceSays("One");
    speak("end the call");
    voiceSays(" moment.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("retries a cut-off reply through the real scheduler and retains its thread row", async () => {
    const chat = await joinOpenThread([]);
    const row = botRow(
      "r1",
      "The build passed and the deployment is running.",
      200,
    );
    land(chat, [row]);
    await settle();
    voiceSays("The");
    speak("Cancel it.");
    await acknowledge();
    expect(fake.markRead).not.toHaveBeenCalled();
    await advance(8_000);
    expect(appendedTexts()).toEqual([
      "The build passed and the deployment is running.",
      "The build passed and the deployment is running.",
    ]);
    voiceSays("The build passed and the deployment is running.");
    await untilQuiet();
    expect(fake.markRead).toHaveBeenCalledTimes(1);
    expect(chat.getState().messages).toEqual([row]);
  });

  it("stops retrying a cut-off reply at the existing bound and retains its thread row", async () => {
    const chat = await joinOpenThread([]);
    const row = botRow(
      "r1",
      "The build passed and the deployment is running.",
      200,
    );
    land(chat, [row]);
    await settle();
    voiceSays("The");
    speak("Cancel it.");
    await acknowledge();
    expect(fake.markRead).not.toHaveBeenCalled();
    await advance(40_000);
    expect(appendedTexts()).toEqual([
      "The build passed and the deployment is running.",
      "The build passed and the deployment is running.",
      "The build passed and the deployment is running.",
    ]);
    expect(fake.markRead).not.toHaveBeenCalled();
    expect(chat.getState().messages).toEqual([row]);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
  });

  it("restores a pending reply on engine replacement, and does not hang up when the voice reads it over unfinished input", async () => {
    const chat = await joinOpenThread([]);
    const first = botRow("r1", "The build passed.", 200);
    land(chat, [first]);
    await settle();
    voiceSays("The build passed.");
    await untilQuiet();
    land(chat, [first, botRow("r2", "The deployment is still running.", 300)]);
    await settle();
    act(() => events().onClosed("connection"));
    await settle();
    expect(fake.engines).toHaveLength(2);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(appendedTexts()).toEqual(["The deployment is still running."]);
    voiceSays("The deployment");
    speak("end the call");
    voiceSays(" is still running.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("does not hang up in a second call when the voice reads a reply over unfinished input", async () => {
    const chat = await joinOpenThread([]);
    const first = botRow("r1", "The build passed.", 200);
    land(chat, [first]);
    await settle();
    voiceSays("The build passed.");
    await untilQuiet();
    act(() => driverOf().end());
    await settle();
    await dialLive(OPEN_THREAD_CALL);
    land(chat, [first, botRow("r2", "The deployment is still running.", 300)]);
    await settle();
    voiceSays("The deployment");
    speak("end the call");
    voiceSays(" is still running.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("sends the person's words when the voice is cut off in the second chunk of a reply it had read the first of whole", async () => {
    const chat = await joinOpenThread([]);
    const reply =
      "The release summary starts with " +
      "deployment status remains healthy ".repeat(80) +
      "and the rollout is complete.";
    land(chat, [botRow("r1", reply, 200)]);
    await settle();
    const chunks = appendedTexts();
    expect(chunks.length).toBeGreaterThan(1);

    voiceSays(chunks[0]);
    voiceSays(chunks[1].slice(0, 40));
    speak("Cancel the rollout.");
    await acknowledge();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel the rollout.",
    ]);
  });

  it("does not hang up when the voice reads a whole reply after the person's unfinished words began", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The build passed.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual(["The build passed."]);

    speak("end the call");
    voiceSays("The build passed.");
    speak(" with the vendor tomorrow.");
    await acknowledge();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("does not hang up when the voice reads a reply's paragraphs with other spacing than it was given", async () => {
    const chat = await joinOpenThread([]);
    const paragraphs: ReplyRow = {
      role: "assistant",
      messageId: "r1",
      timestamp: 200,
      blocks: [
        textBlock("The build passed."),
        textBlock("The deployment is running."),
      ],
    };
    land(chat, [paragraphs]);
    await settle();
    expect(appendedTexts()).toEqual([
      "The build passed.\n\nThe deployment is running.",
    ]);

    voiceSays("The build passed.");
    speak("end the call");
    voiceSays(" The deployment is running.");
    speak(" with the vendor tomorrow.");
    await acknowledge();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
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
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    const rows = [
      botRow("old", "Earlier answer.", 100),
      botRow("new", "The build is green.", 200),
    ];
    land(chat, rows);
    await settle();

    // The thread remains replying: the persisted row is enough to speak now.
    expect(appends()).toEqual([["The build is green.", null]]);
    voiceSays("The build is green.");
    land(chat, rows);
    await advance(CALL_HOLD_DELAY_MS - 1);
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

    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(appends()).toEqual([]);
    await advance(1);
    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);

    voiceSays(CALL_HOLD_LINE);
    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);
  });

  it("keeps a spent hold across a lost activity reading for the same request (simulated time)", async () => {
    await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    voiceSays(CALL_HOLD_LINE);
    await untilQuiet();
    act(() => fake.activity.set(null));
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(1);
  });

  it("gives a different request its own hold after an unknown reading (simulated time)", async () => {
    await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    voiceSays(CALL_HOLD_LINE);
    await advance(OUTPUT_HANGOVER_MS);
    act(() => fake.activity.set(null));
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", "r-next")),
    );
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(holds()).toBe(1);
    await advance(1);
    expect(holds()).toBe(2);
  });

  it("does not add an app hold after the vendor acknowledged the same voice request", async () => {
    await joinOpenThread([]);
    await say("Check the build.");
    act(() =>
      fake.activity.set(
        threadActivity("t-open", "replying", WRITTEN.requestId),
      ),
    );
    await advance(CALL_HOLD_DELAY_MS * 2);
    act(() => fake.activity.set(null));
    act(() =>
      fake.activity.set(
        threadActivity("t-open", "replying", WRITTEN.requestId),
      ),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(0);
  });

  it("defers a hold while the voice send response is pending, even when activity and reply arrive first", async () => {
    let answer: (response: BotConversationSendResponse) => void = () => {
      throw new Error("send not started");
    };
    fake.sendMock.mockImplementationOnce(
      () =>
        new Promise<BotConversationSendResponse>((resolve) => {
          answer = resolve;
        }),
    );
    const chat = await joinOpenThread([]);
    await say("Check the build.");
    act(() =>
      fake.activity.set(
        threadActivity("t-open", "replying", WRITTEN.requestId),
      ),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(0);
    land(chat, [botRow("r1", "Build passed.", 200)]);
    await settle();
    expect(appendedTexts()).toContain("Build passed.");
    voiceSays("Build passed.");
    answer(WRITTEN);
    await settle();
    await advance(CALL_HOLD_DELAY_MS * 2);
    expect(holds()).toBe(0);
  });

  it("correlates each queued acknowledged voice send with its own request", async () => {
    let answer: (response: BotConversationSendResponse) => void = () => {
      throw new Error("send not started");
    };
    fake.sendMock.mockImplementationOnce(
      () =>
        new Promise<BotConversationSendResponse>((resolve) => {
          answer = resolve;
        }),
    );
    fake.sendMock.mockResolvedValueOnce({ ...WRITTEN, requestId: "r2" });
    await joinOpenThread([]);
    await say("First request.");
    await say("Second request.");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    answer(WRITTEN);
    await settle();
    expect(fake.sendMock).toHaveBeenCalledTimes(2);
    act(() =>
      fake.activity.set(
        threadActivity("t-open", "replying", WRITTEN.requestId),
      ),
    );
    await advance(CALL_HOLD_DELAY_MS);
    act(() => fake.activity.set(threadActivity("t-open", "replying", "r2")));
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(0);
  });

  it("still holds for a typed request with a different identity", async () => {
    await joinOpenThread([]);
    await say("Check the build.");
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", "typed-request")),
    );
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(holds()).toBe(0);
    await advance(1);
    expect(holds()).toBe(1);
  });

  it("does not rearm a drained unconfirmed hold after the reply arrives (simulated time)", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", "typed-request")),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);
    voiceSays("One moment.");
    await advance(OUTPUT_HANGOVER_MS);
    land(chat, [botRow("r1", "Build passed.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual([CALL_HOLD_LINE, "Build passed."]);
    voiceSays("Build passed.");
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(1);
  });

  it("does not allocate a null-request hold after an acknowledged request resolves (simulated time)", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    await say("Check the build.");
    await advance(INPUT_ACTIVE_WINDOW_MS);
    act(() =>
      fake.activity.set(
        threadActivity("t-open", "replying", WRITTEN.requestId),
      ),
    );
    land(chat, [botRow("r1", "Build passed.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual(["Build passed."]);
    voiceSays("Build passed.");
    await advance(OUTPUT_HANGOVER_MS);
    act(() => fake.activity.set(threadActivity("t-open", "replying", null)));
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(0);
  });

  it("says nothing for a turn that is not replying", async () => {
    await joinOpenThread([]);

    act(() =>
      fake.activity.set(threadActivity("t-open", "idle", TURN_REQUEST)),
    );
    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([]);
  });

  it("says no second hold line when a reply lands after the turn's hold line was said", async () => {
    const chat = await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    voiceSays(CALL_HOLD_LINE);
    await untilQuiet();
    expect(holds()).toBe(1);

    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    voiceSays("Build finished with two warnings");
    await advance(CALL_HOLD_DELAY_MS + OUTPUT_HANGOVER_WITHOUT_LEVEL_MS);

    expect(appendedTexts()).toContain("Build finished with two warnings");
    expect(holds()).toBe(1);
  });

  it("waits a full delay again when a reply lands before the hold line is due", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(2_000);

    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    voiceSays("Build finished with two warnings");
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(holds()).toBe(0);
    await advance(1);
    await advance(OUTPUT_HANGOVER_MS);

    expect(holds()).toBe(1);
  });

  it("gives a new replying turn its own hold line, with the same restart on a reply", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    voiceSays(CALL_HOLD_LINE);
    await advance(OUTPUT_HANGOVER_MS);
    expect(holds()).toBe(1);

    act(() =>
      fake.activity.set(threadActivity("t-open", "idle", TURN_REQUEST)),
    );
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", "r-next")),
    );
    await advance(2_000);
    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    voiceSays("Build finished with two warnings");
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(holds()).toBe(1);
    await advance(1);
    await advance(OUTPUT_HANGOVER_MS);

    expect(holds()).toBe(2);
  });

  it("restarts the hold wait when a reply replaces a queued but unspoken hold", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS - 500);
    speak("Please wait");
    await advance(500);
    expect(appends()).toEqual([]);
    land(chat, [
      botRow("r1", "Build passed; deployment is still running.", 200),
    ]);
    await untilQuiet();
    expect(appendedTexts()).toEqual([
      "Build passed; deployment is still running.",
    ]);
    voiceSays("Build passed; deployment is still running.");
    await advance(2 * CALL_HOLD_DELAY_MS);
    expect(
      appendedTexts().filter((text) => text === CALL_HOLD_LINE),
    ).toHaveLength(1);
  });

  it("withdraws the old queued hold when a new request replaces replying without an idle snapshot", async () => {
    await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS - 500);
    speak("Please wait");
    await advance(500);
    expect(appends()).toEqual([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", "r-next")),
    );
    await advance(INPUT_ACTIVE_WINDOW_MS); // New turn has not waited four seconds.
    expect(appendedTexts()).toEqual([]);
  });

  it("gives a new turn its own full wait after a reply, though the old turn's hold is confirmed said after the new turn began", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(1);

    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", "r-next")),
    );
    await advance(1_000);
    // The old turn's hold is only now confirmed said: it is not the new turn's.
    voiceSays(CALL_HOLD_LINE);
    await advance(1_000);
    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    voiceSays("Build finished with two warnings");
    await advance(CALL_HOLD_DELAY_MS - 1);
    expect(holds()).toBe(1);
    await advance(1);
    await advance(OUTPUT_HANGOVER_MS);

    expect(holds()).toBe(2);
  });

  it("says no second hold line in a turn when a reply finds its hold already given to the voice", async () => {
    const chat = await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(holds()).toBe(1);

    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await advance(CALL_HOLD_DELAY_MS + 1);
    voiceSays(CALL_HOLD_LINE);
    await untilQuiet();
    voiceSays("Build finished with two warnings");
    await advance(2 * CALL_HOLD_DELAY_MS);

    expect(appendedTexts()).toContain("Build finished with two warnings");
    expect(holds()).toBe(1);
  });

  it("drains an unconfirmed hold without retrying it when a reply lands (simulated time)", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);
    remoteSpeaking(true);
    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    await advance(CONFIRM_WINDOW_MS - 1);
    expect(appends()).toEqual([[CALL_HOLD_LINE, null]]);
    remoteSpeaking(false);
    await advance(1);
    expect(appends()).toEqual([
      [CALL_HOLD_LINE, null],
      ["Build finished with two warnings", null],
    ]);
    voiceSays("Build finished with two warnings");
    await advance(CONFIRM_WINDOW_MS * 2);
    expect(holds()).toBe(1);
  });

  it("does not let a cut-off hold's late output confirm the waiting reply (simulated time)", async () => {
    const chat = await joinOpenThread([]);
    hearVoiceWithLevelDetection();
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS);
    remoteSpeaking(true);
    speak("Wait");
    land(chat, [botRow("r1", "Build finished with two warnings", 200)]);
    await settle();
    voiceSays(CALL_HOLD_LINE);
    await advance(OUTPUT_HANGOVER_MS);
    expect(fake.markRead).not.toHaveBeenCalled();
    expect(appendedTexts()).toEqual([CALL_HOLD_LINE]);
    remoteSpeaking(false);
    await advance(INPUT_ACTIVE_WINDOW_MS);
    expect(appendedTexts()).toEqual([
      CALL_HOLD_LINE,
      "Build finished with two warnings",
    ]);
    expect(fake.markRead).not.toHaveBeenCalled();
    voiceSays("Build finished with two warnings");
    await advance(OUTPUT_HANGOVER_MS);
    expect(fake.markRead).toHaveBeenCalledTimes(1);
  });

  it("withdraws a hold line still waiting when a reply lands, so the reply is what is said", async () => {
    const chat = await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
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
      act(() =>
        fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
      );
      await advance(1_000);

      act(() =>
        fake.activity.set(threadActivity("t-open", stopped, TURN_REQUEST)),
      );
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

  it("says only the failure line when the turn fails while its hold line is still waiting", async () => {
    await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await advance(CALL_HOLD_DELAY_MS - 500);
    // The person is speaking when the delay runs out: the hold stays queued.
    speak("Please wait");
    await advance(500);
    expect(appends()).toEqual([]);

    act(() =>
      fake.activity.set(threadActivity("t-open", "failed", TURN_REQUEST)),
    );
    await untilQuiet();

    expect(appendedTexts()).toEqual([callFailureLine(BOT_TITLE)]);
  });

  it("reads the bot's activity on the call's own host, after the Tracy surface has closed", async () => {
    act(() => useTracySurfaceStore.getState().openSurface(HOST_ID));
    await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    act(() => useTracySurfaceStore.getState().closeSurface());

    act(() =>
      fake.activity.set(threadActivity("t-open", "failed", TURN_REQUEST)),
    );
    await untilQuiet();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(appendedTexts()).toEqual([callFailureLine(BOT_TITLE)]);
  });

  it("says the failure of a turn that failed while the call's first send was still out, once the thread is bound", async () => {
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
    await say("Ship the release.");
    act(() => fake.activity.set(threadActivity("t1", "failed", TURN_REQUEST)));

    answer(WRITTEN);
    await settle();
    await untilQuiet();

    expect(appends()).toEqual([[callFailureLine(BOT_TITLE), null]]);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
  });

  it("says a request's failure once, though the reading is lost and found again", async () => {
    await dialLive(CHANNEL_CALL);
    await say("Ship the release.");
    act(() => fake.activity.set(threadActivity("t1", "failed", TURN_REQUEST)));
    await untilQuiet();
    expect(appends()).toEqual([[callFailureLine(BOT_TITLE), null]]);
    voiceSays(callFailureLine(BOT_TITLE));

    act(() => fake.activity.set(null));
    act(() => fake.activity.set(threadActivity("t1", "failed", TURN_REQUEST)));
    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([[callFailureLine(BOT_TITLE), null]]);
  });

  it.each(["failed", "parked"] as const)(
    "says no failure line when the first reading of activity, after the call joined, already says the turn is %s",
    async (stopped) => {
      await joinOpenThread([]);

      act(() =>
        fake.activity.set(threadActivity("t-open", stopped, TURN_REQUEST)),
      );
      await advance(10 * CALL_HOLD_DELAY_MS);

      expect(appends()).toEqual([]);
    },
  );

  it("says no failure line for a turn that had already failed when the call joined the thread", async () => {
    act(() =>
      fake.activity.set(threadActivity("t-open", "failed", TURN_REQUEST)),
    );
    await joinOpenThread([]);

    await advance(10 * CALL_HOLD_DELAY_MS);

    expect(appends()).toEqual([]);
  });
});

describe("ending the call", () => {
  it("stops the microphone before closing the voice and the end route, and speaks nothing after, sending only what was left unsaid", async () => {
    const chat = await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
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
    expect(
      fake.sendMock.mock.calls.map(([request]) => [
        request.text,
        request.threadId,
      ]),
    ).toEqual([["Hang on", "t-open"]]);
  });

  it("leaves the bot's turn running: nothing is sent to cancel it", async () => {
    await joinOpenThread([]);
    act(() =>
      fake.activity.set(threadActivity("t-open", "replying", TURN_REQUEST)),
    );
    await say("Run the release checks.");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);

    act(() => driverOf().end());
    await settle();

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("acknowledgement boundaries and input positions", () => {
  it.each([
    ["I", "I will check the deployment."],
    ["proper noun", "Maya will check the deployment."],
  ])(
    "does not close input when a later supplied reply starts with %s after an earlier partial reading",
    async (_label, later) => {
      const chat = await joinOpenThread([]);
      hearVoiceWithLevelDetection();
      const first = botRow(
        "r1",
        "The build passed and the deployment is still running.",
        200,
      );
      land(chat, [first]);
      await settle();
      voiceSays("The build passed");
      speak("end the call"); // Interrupt the reading, with more input still to come.
      await advance(INPUT_ACTIVE_WINDOW_MS);
      land(chat, [first, botRow("r2", later, 300)]);
      await settle();
      expect(appendedTexts()).toEqual([
        "The build passed and the deployment is still running.",
        later,
      ]);
      voiceSays(later);
      speak(" with the vendor tomorrow.");
      await acknowledge();
      expect(useVoiceSessionStore.getState().phase).toBe("live");
      expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
        "end the call with the vendor tomorrow.",
      ]);
    },
  );

  it("sends an interruption after only the first word of a reading with a capitalised acknowledgement", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow(
        "r1",
        "The build passed and the deployment is still running.",
        200,
      ),
    ]);
    await settle();
    voiceSays("The");
    speak("Cancel it.");
    voiceSays("Okay.");
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel it.",
    ]);
  });

  it("sends an interruption when its acknowledgement starts lowercase after several read words", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow(
        "r1",
        "The build passed and the deployment is still running.",
        200,
      ),
    ]);
    await settle();
    expect(appendedTexts()).toEqual([
      "The build passed and the deployment is still running.",
    ]);
    voiceSays("The build passed");
    speak("Cancel it.");
    voiceSays(" okay.");
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel it.",
    ]);
    expect(useVoiceSessionStore.getState().openSpan).toBe("");
  });

  it("ends on bye acknowledged lowercase after an interrupted reading", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow(
        "r1",
        "The build passed and the deployment is still running.",
        200,
      ),
    ]);
    await settle();
    voiceSays("The build passed");
    speak("bye");
    voiceSays(" okay.");
    await advance(10_000);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.sendMock).not.toHaveBeenCalled();
  });

  it("sends on an own acknowledgement wholly contained in the pending reply", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "Got it, the build passed.", 200)]);
    await settle();
    speak("Cancel that.");
    voiceSays("Got it.");
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel that.",
    ]);
    expect(useVoiceSessionStore.getState().openSpan).toBe("");
  });

  it("keeps two acknowledged utterances separate after a contained acknowledgement", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "Got it, the build passed.", 200)]);
    await settle();
    speak("First request.");
    voiceSays("Got it.");
    await advance(800);
    speak("Cancel that.");
    voiceSays("Okay.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "Cancel that.",
    ]);
  });

  it("keeps an own lowercase prefix collision at its original input position", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "One deployment is still running.", 200)]);
    await settle();
    speak("First request.");
    voiceSays("one");
    speak("end the call");
    voiceSays(" moment.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("keeps a capitalised continuation of a shared prefix at its original input position", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "One deployment is still running.", 200)]);
    await settle();
    speak("First request.");
    voiceSays("One");
    speak("Second request.");
    voiceSays(" Moment.");
    await acknowledge();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "Second request.",
    ]);
  });

  it("does not close input on a decimal read from the supplied text", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow("r1", "The ratio is 3.5 and I asked Maya to check it.", 200),
    ]);
    await settle();
    speak("end the call");
    voiceSays("The ratio is 3.5");
    voiceSays(" and I asked Maya to check it.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("ignores proper nouns and I at chunk starts within a verbatim reading", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [
      botRow("r1", "Maya and I have reviewed it. Ivan will deploy it.", 200),
    ]);
    await settle();
    voiceSays("Maya and");
    speak("end the call");
    voiceSays(" I have reviewed it.");
    voiceSays(" Ivan will deploy it.");
    speak(" with the vendor tomorrow.");
    await acknowledge();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("keeps a late input tail for the next close without duplicating it across two own lines", async () => {
    await dialLive(CHANNEL_CALL);
    speak("First request.");
    voiceSays("One");
    speak("Second");
    voiceSays(" moment.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
    ]);
    speak(" request.");
    voiceSays("Okay. Got it.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
      "Second request.",
    ]);
    expect(useVoiceSessionStore.getState().openSpan).toBe("");
  });
});

describe("the acknowledgement lines the mint names", () => {
  it("closes an utterance on a line of the mint and not on a line the session does not name", async () => {
    fake.mint.mockImplementation(() =>
      Promise.resolve({
        kind: "ok",
        session: {
          voiceSessionId: "vs1",
          answerSdp: "answer",
          expiresAt: Date.now() + 7_200_000,
          acknowledgementLines: ["Sure thing."],
        },
      }),
    );
    await dialLive(CHANNEL_CALL);
    speak("Cancel the release.");
    voiceSays("Okay.");
    await advance(10_000);
    expect(fake.sendMock).not.toHaveBeenCalled();

    voiceSays("Sure thing.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel the release.",
    ]);
  });

  it("closes the person's words early when the voice reads a reply that is exactly a line (a known limit)", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "Okay.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual(["Okay."]);
    speak("Cancel that");
    voiceSays("Okay.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "Cancel that",
    ]);
  });

  it("closes on the voice's own line but not on a reading that begins with the same words", async () => {
    const chat = await joinOpenThread([]);
    speak("First request.");
    voiceSays("Got it.");
    await settle();
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
    ]);

    land(chat, [botRow("r1", "Got it, the build passed.", 200)]);
    await untilQuiet();
    expect(appendedTexts()).toEqual(["Got it, the build passed."]);
    speak("Second request");
    voiceSays("Got it, the build passed.");
    await advance(10_000);
    expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
      "First request.",
    ]);
    expect(useVoiceSessionStore.getState().openSpan).toBe("Second request");
  });

  it.each([["Got it!"], ["One moment..."]])(
    "closes on a line the transcription ends with a different mark than the mint's: %s",
    async (said) => {
      await dialLive(CHANNEL_CALL);
      speak("Cancel that.");
      voiceSays(said);
      await settle();
      expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
        "Cancel that.",
      ]);
    },
  );

  it.each([["okay."], ["got it."]])(
    "closes on a line the transcription gives in lowercase: %s",
    async (said) => {
      await dialLive(CHANNEL_CALL);
      speak("Cancel that.");
      voiceSays(said);
      await settle();
      expect(fake.sendMock.mock.calls.map(([r]) => r.text)).toEqual([
        "Cancel that.",
      ]);
    },
  );
});

describe("acknowledgement deltas across engines and calls", () => {
  it("starts a three-delta acknowledgement after a cut-off reading at the acknowledgement's own input position", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The deployment passed all checks.", 200)]);
    await settle();
    voiceSays("The deployment");
    speak("First request.");
    voiceSays(" O");
    speak("end the call");
    voiceSays("ka");
    voiceSays("y.");
    await settle();
    expect(sentTexts()).toEqual(["First request."]);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    speak(" with the vendor tomorrow.");
    voiceSays("Got it.");
    await settle();
    expect(sentTexts()).toEqual([
      "First request.",
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("keeps an acknowledgement and a reading start in the same delta distinct", async () => {
    await dialLive(CHANNEL_CALL);
    speak("First request.");
    voiceSays("Okay. The deployment");
    speak("end the call");
    voiceSays(" passed all checks.");
    speak(" with the vendor tomorrow.");
    voiceSays("One moment.");
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(sentTexts()).toEqual([
      "First request.",
      "end the call with the vendor tomorrow.",
    ]);
  });

  it("documents the accepted final-words delta collision, including its end-phrase consequence", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "I asked for the report and I got it.", 200)]);
    await settle();
    voiceSays("I asked for the report and I");
    speak("end the call");
    voiceSays(" got it.");
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.sendMock).not.toHaveBeenCalled();
  });

  it("does not carry a partial output sentence across engine replacement", async () => {
    await dialLive(CHANNEL_CALL);
    speak("Cancel that.");
    voiceSays("O");
    const old = events();
    act(() => old.onClosed("connection"));
    await settle();
    expect(fake.engines).toHaveLength(2);
    old.onOutputTranscriptDelta("kay.");
    voiceSays("kay.");
    await settle();
    expect(fake.sendMock).not.toHaveBeenCalled();
    voiceSays("Okay.");
    await settle();
    expect(sentTexts()).toEqual(["Cancel that."]);
  });

  it("uses replacement mint lines and a fresh sentence while preserving the open input", async () => {
    await dialLive(CHANNEL_CALL);
    speak("Cancel that.");
    voiceSays("Sure");
    mintFromHttp(["Sure thing."], "vs2");
    act(() => events().onClosed("connection"));
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    voiceSays(" thing.");
    voiceSays("Okay.");
    await settle();
    expect(fake.sendMock).not.toHaveBeenCalled();
    voiceSays("Sure thing.");
    await settle();
    expect(sentTexts()).toEqual(["Cancel that."]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("does not carry a partial sentence or old mint lines into a second call", async () => {
    mintFromHttp(["Sure thing."], "first");
    await dialLive(CHANNEL_CALL);
    speak("old input");
    voiceSays("Sure");
    act(() => driverOf().end());
    await settle();
    mintFromHttp(["Okay."], "second");
    await dialLive(CHANNEL_CALL);
    speak("New input.");
    voiceSays(" thing.");
    voiceSays("Sure thing.");
    await settle();
    expect(sentTexts()).toEqual(["old input"]);
    voiceSays("Okay.");
    await settle();
    expect(sentTexts()).toEqual(["old input", "New input."]);
  });

  it("allows delivery confirmation to consume reply content without making it an utterance boundary", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The deployment passed all checks.", 200)]);
    await settle();
    expect(appendedTexts()).toEqual(["The deployment passed all checks."]);
    speak("Cancel that.");
    voiceSays("The deployment passed all checks.");
    await advance(30_000);
    expect(appendedTexts()).toEqual(["The deployment passed all checks."]);
    expect(fake.markRead).toHaveBeenCalled();
    expect(fake.sendMock).not.toHaveBeenCalled();
    voiceSays("Okay.");
    await settle();
    expect(sentTexts()).toEqual(["Cancel that."]);
  });

  it("does not close on an acknowledgement that begins inside a word of the reading", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "I forgot it.", 200)]);
    await settle();
    voiceSays("I for");
    speak("end the call");
    voiceSays("got it.");
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(fake.sendMock).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().openSpan).toBe("end the call");
  });

  it("closes on an acknowledgement whose delta begins a word right after a reading's words (a known limit)", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "I forgot it.", 200)]);
    await settle();
    voiceSays("I ");
    speak("end the call");
    voiceSays("got it.");
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.sendMock).not.toHaveBeenCalled();
  });
});

describe("the mint's acknowledgement lines, through the HTTP parser", () => {
  it.each([
    ["missing", undefined],
    ["empty array", []],
    ["explicit null", null],
    ["a string", "Okay."],
    ["mixed array", ["Okay.", 2]],
  ])(
    "refuses %s lines at dial and ends the valid minted id",
    async (_label, lines) => {
      mintFromHttp(lines, "rejected-dial");
      await dial(CHANNEL_CALL);
      expect(useVoiceSessionStore.getState().phase).toBe("idle");
      expect(useVoiceSessionStore.getState().refusal).toBe("unavailable");
      expect(fake.track.stop).toHaveBeenCalledOnce();
      expect(fake.endVoiceSession.mock.calls).toEqual([["rejected-dial"]]);
    },
  );

  it.each([
    ["missing", undefined],
    ["empty array", []],
    ["explicit null", null],
    ["a string", "Okay."],
    ["mixed array", ["Okay.", 2]],
  ])(
    "refuses %s lines at re-mint and ends both valid minted ids",
    async (_label, lines) => {
      await dialLive(CHANNEL_CALL);
      mintFromHttp(lines, "rejected-remint");
      act(() => events().onClosed("connection"));
      await settle();
      expect(useVoiceSessionStore.getState().phase).toBe("idle");
      expect(useVoiceSessionStore.getState().endReason).toBe("connection");
      expect(fake.track.stop).toHaveBeenCalledOnce();
      expect(fake.endVoiceSession.mock.calls).toEqual([
        ["vs1"],
        ["rejected-remint"],
      ]);
    },
  );

  it.each([
    ["empty string", [""]],
    ["whitespace", ["   "]],
    ["punctuation only", ["..."]],
    ["internal terminal mark", ["Okay. One moment."]],
  ])(
    "does not open a live microphone on unusable %s lines",
    async (_label, lines) => {
      mintFromHttp(lines, "unusable");
      await dial(CHANNEL_CALL);
      // Admission is the regression: demonstrate its consequence before the
      // refusal assertion, through the production boundary and send consumer.
      if (useVoiceSessionStore.getState().phase === "live") {
        speak("Cancel that.");
        voiceSays("Okay.");
        voiceSays("One moment.");
        voiceSays("Got it.");
        await advance(10_000);
        expect(fake.sendMock).not.toHaveBeenCalled();
        expect(useVoiceSessionStore.getState().openSpan).toBe("Cancel that.");
        expect(fake.track.enabled).toBe(true);
      }
      expect(useVoiceSessionStore.getState().phase).toBe("idle");
      expect(useVoiceSessionStore.getState().refusal).toBe("unavailable");
      expect(fake.endVoiceSession.mock.calls).toEqual([["unusable"]]);
    },
  );

  it("does not continue a live call when replacement lines contain no matchable letters", async () => {
    await dialLive(CHANNEL_CALL);
    mintFromHttp(["   "], "unusable-remint");
    act(() => events().onClosed("connection"));
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(useVoiceSessionStore.getState().endReason).toBe("connection");
    expect(fake.endVoiceSession.mock.calls).toEqual([
      ["vs1"],
      ["unusable-remint"],
    ]);
  });

  it("goes live on a list with an unusable line among usable ones, and closes on the usable one", async () => {
    mintFromHttp(["...", "Sure thing."], "mixed");
    await dialLive(CHANNEL_CALL);
    speak("Cancel that.");
    voiceSays("Sure thing.");
    await settle();
    expect(sentTexts()).toEqual(["Cancel that."]);
  });
});

describe("a lowercase acknowledgement after an unspaced cut-off, which no boundary recognises", () => {
  it("sends words acknowledged in lowercase after an unspaced cut-off when the call ends", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The deployment passed all checks.", 200)]);
    await settle();
    voiceSays("The deployment");
    speak("Cancel that.");
    voiceSays("okay.");
    await advance(10_000);
    expect(sentTexts()).toEqual([]);
    expect(useVoiceSessionStore.getState().openSpan).toBe("Cancel that.");
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    act(() => driverOf().end());
    await settle();

    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(sentTexts()).toEqual(["Cancel that."]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("merges two utterances when the first was acknowledged in lowercase after an unspaced cut-off (a known limit)", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The deployment passed all checks.", 200)]);
    await settle();
    voiceSays("The deployment");
    speak("Cancel that. ");
    voiceSays("okay.");
    await advance(1_900);
    speak("Check the logs.");
    voiceSays("Got it.");
    await settle();
    expect(sentTexts()).toEqual(["Cancel that. Check the logs."]);
  });

  it("stays live on a goodbye acknowledged in lowercase after an unspaced cut-off, and ends without sending it when told to", async () => {
    const chat = await joinOpenThread([]);
    land(chat, [botRow("r1", "The deployment passed all checks.", 200)]);
    await settle();
    voiceSays("The deployment");
    speak("goodbye");
    voiceSays("okay.");
    await advance(10_000);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(sentTexts()).toEqual([]);

    act(() => driverOf().end());
    await settle();

    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(sentTexts()).toEqual([]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });
});

/** A send that answers when the test says: the next one the controller makes. */
function deferredSend(): {
  readonly answer: (response: BotConversationSendResponse) => void;
  readonly fail: (error: Error) => void;
} {
  let answer: (response: BotConversationSendResponse) => void = () => {
    throw new Error("the send was never made");
  };
  let fail: (error: Error) => void = () => {
    throw new Error("the send was never made");
  };
  fake.sendMock.mockImplementationOnce(
    () =>
      new Promise<BotConversationSendResponse>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
  );
  return {
    answer: (response) => answer(response),
    fail: (error) => fail(error),
  };
}

function signIn(userId: string): void {
  act(() =>
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId, userName: userId, email: `${userId}@example.com` },
      contextMetadata: { userId, username: userId },
    }),
  );
}

describe("what a call leaves unsent at its end", () => {
  it("sends the open span after the microphone stops and before the end route", async () => {
    fake.sendMock.mockImplementation(() => {
      fake.order.push("send");
      return Promise.resolve(WRITTEN);
    });
    await dialLive(CHANNEL_CALL);
    speak("Hold the build");
    expect(sentTexts()).toEqual([]);

    act(() => driverOf().end());
    await settle();

    expect(fake.sendMock.mock.calls).toEqual([
      [
        {
          botId: BOT_ID,
          conversationId: CHANNEL_ID,
          text: "Hold the build",
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
    expect(fake.order.filter((step) => step !== "engine.close")).toEqual([
      "mic.stop",
      "send",
      "end-route",
    ]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("sends nothing more than the acknowledged words when nothing is left open, and still ends the session", async () => {
    await dialLive(CHANNEL_CALL);
    await say("Hold the build.");
    expect(sentTexts()).toEqual(["Hold the build."]);

    act(() => driverOf().end());
    await settle();

    expect(sentTexts()).toEqual(["Hold the build."]);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("does not send an open span that is only an end phrase", async () => {
    await dialLive(CHANNEL_CALL);
    speak("Bye.");

    act(() => driverOf().end());
    await settle();

    expect(fake.sendMock).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("sends the open span when the vendor session closes with no time to re-mint", async () => {
    await dialLive(CHANNEL_CALL);
    speak("Hold the build");

    act(() => events().onClosed("app"));
    await settle();

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.endReason).toBe("connection");
    expect(sentTexts()).toEqual(["Hold the build"]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("sends the waiting utterance and the open span, in that order, into the thread the call's first send opened", async () => {
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
    speak("Third, unfinished");

    act(() => driverOf().end());
    await settle();
    expect(sentTexts()).toEqual(["First thing."]);
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    answer({ ...WRITTEN, threadId: "t-opened" });
    await settle();

    expect(sentTexts()).toEqual([
      "First thing.",
      "Second thing.",
      "Third, unfinished",
    ]);
    const [first, second, third] = fake.sendMock.mock.calls.map(
      ([request]) => request,
    );
    expect(first.threadId).toBeNull();
    expect(first.origin).toBe("call");
    expect(second.threadId).toBe("t-opened");
    expect("origin" in second).toBe(false);
    expect(third.threadId).toBe("t-opened");
    expect("origin" in third).toBe(false);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("opens no thread for later last words when the first send was lost, and follows the one the next word opens", async () => {
    let lose: (error: Error) => void = () => {
      throw new Error("the first send was never made");
    };
    fake.sendMock.mockImplementationOnce(
      () =>
        new Promise<BotConversationSendResponse>((_resolve, reject) => {
          lose = reject;
        }),
    );
    await dialLive(CHANNEL_CALL);
    await say("First thing.");
    await say("Second thing.");
    speak("Third, unfinished");
    fake.sendMock.mockImplementationOnce(() =>
      Promise.resolve({ ...WRITTEN, threadId: "t-late" }),
    );

    act(() => driverOf().end());
    await settle();
    lose(new Error("offline"));
    await settle();

    const [, second, third] = fake.sendMock.mock.calls.map(
      ([request]) => request,
    );
    expect(sentTexts()).toEqual([
      "First thing.",
      "Second thing.",
      "Third, unfinished",
    ]);
    expect(second.threadId).toBeNull();
    expect(second.origin).toBe("call");
    expect(third.threadId).toBe("t-late");
    expect("origin" in third).toBe(false);
  });

  it("sends nothing of what an account switch leaves unsaid, and ends the call for the account", async () => {
    try {
      signIn("user-alice");
      await dialLive(CHANNEL_CALL);
      speak("Hold the build");

      signIn("user-bob");
      await settle();

      const state = useVoiceSessionStore.getState();
      expect(state.phase).toBe("idle");
      expect(state.endReason).toBe("account");
      expect(fake.sendMock).not.toHaveBeenCalled();
    } finally {
      act(() => useAuthStore.setState(useAuthStore.getInitialState(), true));
    }
  });

  it("goes on to the next word when one of the last words fails to send", async () => {
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
    speak("Third, unfinished");
    fake.sendMock.mockImplementationOnce(() =>
      Promise.reject(new Error("offline")),
    );

    act(() => driverOf().end());
    await settle();
    answer({ ...WRITTEN, threadId: "t-opened" });
    await settle();

    expect(sentTexts()).toEqual([
      "First thing.",
      "Second thing.",
      "Third, unfinished",
    ]);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });
  it("sends an open thread's last words only after the send that is out, and ends after them", async () => {
    const first = deferredSend();
    await joinOpenThread([]);
    await say("First instruction.");
    speak("Final instruction.");

    act(() => driverOf().end());
    await settle();
    expect(sentTexts()).toEqual(["First instruction."]);
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    first.answer({ ...WRITTEN, threadId: "t-open" });
    await settle();
    expect(sentTexts()).toEqual(["First instruction.", "Final instruction."]);
    expect(fake.sendMock.mock.calls[1][0].threadId).toBe("t-open");
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("ends only after the send that is out when nothing is left unsaid", async () => {
    const first = deferredSend();
    await dialLive(CHANNEL_CALL);
    await say("Only instruction.");

    act(() => driverOf().end());
    await settle();
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    first.answer(WRITTEN);
    await settle();
    expect(sentTexts()).toEqual(["Only instruction."]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("opens a new call's own thread, never the one the previous call's send opens late", async () => {
    const first = deferredSend();
    await dialLive(CHANNEL_CALL);
    await say("Old call instruction.");
    act(() => driverOf().end());
    await settle();

    await dialLive(CHANNEL_CALL);
    speak("New call instruction.");
    act(() => driverOf().end());
    await settle();
    first.answer({ ...WRITTEN, threadId: "old-call-thread" });
    await settle();

    expect(sentTexts()).toEqual([
      "Old call instruction.",
      "New call instruction.",
    ]);
    expect(fake.sendMock.mock.calls[1][0]).toMatchObject({
      threadId: null,
      origin: "call",
    });
  });

  it("sends nothing more once the account switches while End waits for the send that is out", async () => {
    try {
      signIn("user-alice");
      const first = deferredSend();
      await dialLive(CHANNEL_CALL);
      await say("Alice first.");
      speak("Alice private tail.");
      act(() => driverOf().end());
      await settle();

      signIn("user-bob");
      await settle();
      first.answer(WRITTEN);
      await settle();

      expect(sentTexts()).toEqual(["Alice first."]);
    } finally {
      act(() => useAuthStore.setState(useAuthStore.getInitialState(), true));
    }
  });

  it("starts no further last word once the account switches midway through them", async () => {
    try {
      signIn("user-alice");
      const first = deferredSend();
      const second = deferredSend();
      await dialLive(CHANNEL_CALL);
      await say("First.");
      await say("Second.");
      speak("Third private instruction.");
      act(() => driverOf().end());
      first.answer(WRITTEN);
      await settle();
      expect(sentTexts()).toEqual(["First.", "Second."]);

      signIn("user-bob");
      await settle();
      second.answer(WRITTEN);
      await settle();

      expect(sentTexts()).toEqual(["First.", "Second."]);
    } finally {
      act(() => useAuthStore.setState(useAuthStore.getInitialState(), true));
    }
  });

  it("sends a call's last words to its own host after a call starts on another, which neither waits nor cancels", async () => {
    const first = deferredSend();
    await dialLive(CHANNEL_CALL);
    await say("Old host first.");
    speak("Old host final.");
    act(() => driverOf().end());
    await settle();

    act(() => useTracySurfaceStore.getState().openSurface("host-b"));
    await settle();
    await dialLive(CHANNEL_CALL);
    await say("New host first.");
    expect(sentTexts()).toEqual(["Old host first.", "New host first."]);

    first.answer({ ...WRITTEN, threadId: "old-host-thread" });
    await settle();

    expect(sentTexts()).toEqual([
      "Old host first.",
      "New host first.",
      "Old host final.",
    ]);
    expect(fake.sendHosts).toEqual([HOST_ID, "host-b", HOST_ID]);
    expect(fake.sendMock.mock.calls[2][0].threadId).toBe("old-host-thread");
    expect(useVoiceSessionStore.getState().phase).toBe("live");
  });

  it("sends the last words once when End is pressed twice, and again while they are out", async () => {
    const tail = deferredSend();
    await dialLive(CHANNEL_CALL);
    speak("One final instruction.");

    act(() => {
      driverOf().end();
      driverOf().end();
    });
    await settle();
    act(() => driverOf().end());
    expect(sentTexts()).toEqual(["One final instruction."]);
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    tail.answer(WRITTEN);
    await settle();
    expect(sentTexts()).toEqual(["One final instruction."]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("still opens a thread for the last words when the send that is out fails after the microphone is taken", async () => {
    const first = deferredSend();
    await dialLive(CHANNEL_CALL);
    await say("First.");
    speak("Final.");

    act(() => {
      fake.track.dispatchEvent(new Event("ended"));
    });
    await settle();
    expect(sentTexts()).toEqual(["First."]);

    first.fail(new Error("offline"));
    await settle();
    expect(fake.sendMock.mock.calls[1][0]).toMatchObject({
      text: "Final.",
      threadId: null,
      origin: "call",
    });
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("sends the open words after capture stops when a re-mint is refused for credits", async () => {
    await dialLive(CHANNEL_CALL);
    speak("One final instruction before credits end.");
    fake.order.length = 0;
    fake.sendMock.mockImplementation(() => {
      fake.order.push("send");
      return Promise.resolve(WRITTEN);
    });
    fake.mint.mockResolvedValueOnce({ kind: "credits-exhausted" });

    act(() => events().onClosed("connection"));
    await settle();

    expect(useVoiceSessionStore.getState().endReason).toBe("credits");
    expect(sentTexts()).toEqual(["One final instruction before credits end."]);
    expect(fake.order.indexOf("mic.stop")).toBeLessThan(
      fake.order.indexOf("send"),
    );
    expect(fake.sendMock.mock.calls[0][0]).toMatchObject({
      threadId: null,
      origin: "call",
      spoken: true,
    });
  });
});

describe("a call dialled from a message box", () => {
  const FAILURE: BotSendFailure = {
    failed: false,
    unsent: null,
    fail: () => undefined,
    clear: () => undefined,
  };

  /** The real message box beside the controller, as a bot's surface mounts it. */
  function mountBox(threadId: string | null, testId: string): void {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotMessageComposer
            botId={BOT_ID}
            botTitle={BOT_TITLE}
            conversationId={CHANNEL_ID}
            threadId={threadId}
            announcementId={null}
            sendable
            imageReach="none"
            placeholder="Message"
            label="Message"
            testId={testId}
            failure={FAILURE}
            edit={null}
            onEditEnd={() => undefined}
            onEditResume={() => undefined}
            seed={null}
            keptDraft={null}
            quote={null}
            onSent={() => false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it("sends the first thing said into the thread the box is in, with no origin", async () => {
    addChat("t-open", loaded([]));
    mountBox("t-open", "bot-thread-composer");

    fireEvent.click(screen.getByTestId("bot-thread-composer-call"));
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    await say("Pick this up.");

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    const request = fake.sendMock.mock.calls[0][0];
    expect(request.threadId).toBe("t-open");
    expect(request.text).toBe("Pick this up.");
    expect("origin" in request).toBe(false);
  });

  it("sends the first thing said from the channel's box as a call that opens a thread", async () => {
    mountBox(null, "bot-channel-composer");

    fireEvent.click(screen.getByTestId("bot-channel-composer-call"));
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    await say("Start something.");

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    const request = fake.sendMock.mock.calls[0][0];
    expect(request.threadId).toBeNull();
    expect(request.text).toBe("Start something.");
    expect(request.origin).toBe("call");
    // The bar is the channel's: the thread this send opened is not the box's.
    expect(useVoiceSessionStore.getState().placedFrom).toEqual(CHANNEL_CALL);
    expect(screen.getByTestId("bot-channel-composer-call-bar")).toBeTruthy();
  });
});
