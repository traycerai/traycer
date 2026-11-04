/**
 * A call's sends through the real call-send mutation and HostClient: what
 * leaves, under whose authority, to which host, and when the end route runs.
 *
 * The controller, `useBotCallSendMutation`, `useHostMutation`, the app's
 * query client, the auth and voice stores and the identity-transition hook
 * are real. The engine, the audio, the bot reads and the messenger at the
 * end of HostClient are the seams; the messenger records every dispatch
 * with the bearer and host it carries.
 */
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
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
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { botConversationSendV13 } from "@traycer/protocol/host/bot/contracts";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";
import { CallController } from "@/components/layout/voice/call-controller";

interface FakeEngine {
  events: VoiceEngineEvents | null;
  readonly close: Mock<() => Promise<void>>;
}

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_A = "host-a";
const HOST_B = "host-b";
const CHANNEL_ID = "chan-1";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-1",
  createdByUserId: "user-1",
  title: "CI bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-bot-1",
  boundHostId: HOST_A,
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "direct",
  appConversationChatId: CHANNEL_ID,
};

interface Binding {
  current: { readonly hostClient: HostClient<HostRpcRegistry> } | null;
}

const fake = vi.hoisted(() => {
  const track = Object.assign(new EventTarget(), {
    kind: "audio",
    enabled: true,
    stop: vi.fn<() => void>(),
  });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  return {
    track,
    stream,
    engines: new Array<FakeEngine>(),
    // The app's binding, which a call's send resolves its named host through.
    binding: ((): Binding => ({ current: null }))(),
    mint: vi.fn<() => Promise<unknown>>(),
    endVoiceSession: vi.fn<(id: string) => Promise<unknown>>(),
    send: vi.fn<
      (
        request: BotConversationSendRequest,
      ) => Promise<BotConversationSendResponse>
    >(),
    open: vi.fn<() => Promise<BotOpenResponse>>(),
  };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({
    requestMicrophoneAccess: () => Promise.resolve("granted"),
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
  useHostBinding: () => fake.binding.current,
}));
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  useBotOpenMutation: () => ({ mutateAsync: fake.open }),
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: () => ({
    snapshot: null,
    error: null,
    deleted: false,
  }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
}));
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
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
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({ data: { bots: [BOT] } }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: [{ environmentId: "env-1", label: "Personal" }] },
  }),
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_A,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
  readHostMethodSchemaVersion: () => botConversationSendV13.schemaVersion,
}));
vi.mock("@/hooks/voice/use-voice-availability-query", () => ({
  useVoiceAvailabilityQuery: () => ({ data: true }),
}));
vi.mock("@/lib/voice/audio-level", () => ({
  watchAudioLevel: () => ({ stop: () => undefined }),
}));
vi.mock("@/lib/voice/gpt-live-engine", () => ({
  createBrowserGptLiveEngine: () => {
    const engine: FakeEngine = {
      events: null,
      close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    };
    fake.engines.push(engine);
    return {
      connect: async (input: {
        readonly exchangeSdp: (offer: string) => Promise<string>;
        readonly events: VoiceEngineEvents;
      }) => {
        engine.events = input.events;
        await input.exchangeSdp("offer");
      },
      appendCommentary: () => undefined,
      close: engine.close,
    };
  },
}));

const WRITTEN: BotConversationSendResponse = {
  messageId: "m1",
  requestId: "r1",
  delivery: "written",
  threadId: "t1",
};
const CHANNEL_CALL: CallTarget = { botId: BOT_ID, threadId: null };

let queryClient: QueryClient;
let entries: HostDirectoryEntry[];
let messenger: MockHostMessenger<HostRpcRegistry>;
let spine: HostClient<HostRpcRegistry>;

/**
 * Another account takes the window, in AuthService's order: the request
 * context the host client sends under first, then the auth store.
 */
function switchAccount(userId: string): void {
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      identity: { userId, username: userId, providerHandle: null },
      bearerToken: `token-${userId}`,
    }),
  );
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
  });
}

function textOf(params: unknown): string {
  if (typeof params !== "object" || params === null || !("text" in params)) {
    return "";
  }
  return typeof params.text === "string" ? params.text : "";
}

/** Every dispatch that reached the messenger: its words, bearer and host. */
function dispatched(): ReadonlyArray<{
  readonly text: string;
  readonly bearer: string;
  readonly hostId: string;
}> {
  return messenger.calls.map((call) => ({
    text: textOf(call.params),
    bearer: call.authority.bearer.getBearerToken(),
    hostId: call.authority.endpoint.hostId,
  }));
}

function sentTexts(): ReadonlyArray<string> {
  return fake.send.mock.calls.map(([request]) => request.text);
}

/** A send that answers when the test says: the next one that reaches the host. */
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
  fake.send.mockImplementationOnce(
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

function events(): VoiceEngineEvents {
  const found = fake.engines.at(-1)?.events ?? null;
  if (found === null) throw new Error("the engine was never connected");
  return found;
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function end(): void {
  const driver = useVoiceSessionStore.getState().driver;
  if (driver === null) throw new Error("the controller mounted no driver");
  driver.end();
}

async function dialLive(): Promise<void> {
  const driver = useVoiceSessionStore.getState().driver;
  if (driver === null) throw new Error("the controller mounted no driver");
  act(() => driver.start(CHANNEL_CALL));
  await settle();
  expect(useVoiceSessionStore.getState().phase).toBe("live");
}

/** The person says `words`; nothing closes the utterance yet. */
function speak(words: string): void {
  act(() => events().onInputTranscriptDelta(words));
}

/** The person says `words` and the voice acknowledges them: one utterance. */
async function say(words: string): Promise<void> {
  speak(words);
  act(() => events().onOutputTranscriptDelta("Okay."));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.engines.length = 0;
  fake.track.stop.mockReset();
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
  fake.endVoiceSession.mockImplementation(() =>
    Promise.resolve({ kind: "ok", closedAt: 1 }),
  );
  fake.send.mockReset();
  fake.send.mockImplementation(() => Promise.resolve(WRITTEN));
  fake.open.mockReset();
  fake.open.mockImplementation(() =>
    Promise.resolve({
      bot: BOT,
      outcome: { kind: "serve-here", claimed: null },
    }),
  );
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
    value: { getUserMedia: () => Promise.resolve(fake.stream) },
  });
  queryClient = createAppQueryClient();
  entries = [
    { ...mockRemoteHostEntry, hostId: HOST_A },
    { ...mockRemoteHostEntry, hostId: HOST_B },
  ];
  let seq = 0;
  messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `dispatch-${String(++seq)}`,
    handlers: { "bot.conversation.send": (request) => fake.send(request) },
  });
  spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      entries.find((entry) => entry.hostId === hostId) ?? null,
    messenger,
  });
  fake.binding.current = { hostClient: spine };
  switchAccount("alice");
  render(
    <QueryClientProvider client={queryClient}>
      <CallController />
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  fake.binding.current = null;
  spine.dispose();
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a call's sends leave only under the account the call started under", () => {
  it("dispatches none of the last words when another account signs in before the send reaches the host", async () => {
    await dialLive();
    speak("Alice private last instruction.");

    await act(async () => {
      end();
      // One turn: past the controller's own check, before the mutation
      // reaches HostClient.
      await Promise.resolve();
      switchAccount("bob");
    });
    await settle();

    expect(dispatched()).toEqual([]);
  });

  it("dispatches no live words when another account signs in before the send reaches the host", async () => {
    await dialLive();
    speak("Alice private live instruction.");

    act(() => {
      events().onOutputTranscriptDelta("Okay.");
      switchAccount("bob");
    });
    await settle();

    expect(dispatched()).toEqual([]);
    expect(useVoiceSessionStore.getState().endReason).toBe("account");
  });

  it("keeps the call's own account when End comes after a switch the controller has not yet seen", async () => {
    await dialLive();
    speak("Alice private before the effect.");

    act(() => {
      switchAccount("bob");
      end();
    });
    await settle();

    expect(dispatched()).toEqual([]);
  });

  it("aborts a send that already left when another account signs in, and sends nothing after it", async () => {
    deferredSend();
    await dialLive();
    await say("Alice dispatched first.");
    speak("Alice tail must not leave.");
    act(() => end());
    await settle();

    act(() => switchAccount("bob"));
    await settle();

    expect(dispatched()).toEqual([
      {
        text: "Alice dispatched first.",
        bearer: "token-alice",
        hostId: HOST_A,
      },
    ]);
    expect(messenger.calls[0].authority.abortSignal.aborted).toBe(true);
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.endVoiceSession).not.toHaveBeenCalled();
  });
});

describe("a call's last words through the real send", () => {
  it("opens a new thread for the last words when the send that is out is rejected, and ends after them", async () => {
    const first = deferredSend();
    await dialLive();
    await say("First rejected instruction.");
    speak("Tail after failure.");
    act(() => end());
    await settle();
    expect(sentTexts()).toEqual(["First rejected instruction."]);
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    first.fail(new Error("host rejected the request"));
    await settle();

    expect(sentTexts()).toEqual([
      "First rejected instruction.",
      "Tail after failure.",
    ]);
    expect(fake.send.mock.calls[1][0]).toMatchObject({
      threadId: null,
      origin: "call",
      spoken: true,
    });
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("runs the end route after the only send that is out is rejected", async () => {
    const first = deferredSend();
    await dialLive();
    await say("Only instruction.");
    act(() => end());
    await settle();
    expect(fake.endVoiceSession).not.toHaveBeenCalled();

    first.fail(new Error("rejected"));
    await settle();

    expect(sentTexts()).toEqual(["Only instruction."]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("refuses the last words when the call's host has gone, sending them to no other host, and still ends", async () => {
    const first = deferredSend();
    await dialLive();
    await say("First on A.");
    speak("Tail on A.");
    act(() => end());
    await settle();

    entries = entries.filter((entry) => entry.hostId !== HOST_A);
    first.answer(WRITTEN);
    await settle();

    expect(dispatched()).toEqual([
      { text: "First on A.", bearer: "token-alice", hostId: HOST_A },
    ]);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("sends the last words under the call's account and floor, and makes only their host's thread list stale", async () => {
    for (const hostId of [HOST_A, HOST_B]) {
      queryClient.setQueryData(
        hostQueryKeys.method<HostRpcRegistry, "bot.thread.list">(
          hostId,
          "bot.thread.list",
          { botId: BOT_ID },
        ),
        { threads: [] },
      );
    }
    await dialLive();
    speak("Tail on the call's host.");
    act(() => end());
    await settle();

    expect(dispatched()).toEqual([
      {
        text: "Tail on the call's host.",
        bearer: "token-alice",
        hostId: HOST_A,
      },
    ]);
    expect(messenger.calls[0].requiredHostMethodVersion).toEqual({
      method: "bot.conversation.send",
      version: botConversationSendV13.schemaVersion,
    });
    const stale = (hostId: string): boolean =>
      queryClient
        .getQueryCache()
        .findAll({
          queryKey: hostQueryKeys.methodScope(hostId, "bot.thread.list"),
        })
        .some((query) => query.state.isInvalidated);
    expect(stale(HOST_A)).toBe(true);
    expect(stale(HOST_B)).toBe(false);
    expect(fake.endVoiceSession.mock.calls).toEqual([["vs1"]]);
  });

  it("sends a call's last words to its own host after a call starts on another", async () => {
    const first = deferredSend();
    await dialLive();
    await say("Old first.");
    speak("Old tail.");
    act(() => end());
    await settle();

    act(() => useTracySurfaceStore.getState().openSurface(HOST_B));
    await settle();
    await dialLive();
    await say("New first.");
    first.answer({ ...WRITTEN, threadId: "old-thread" });
    await settle();

    expect(dispatched().map(({ text, hostId }) => [text, hostId])).toEqual([
      ["Old first.", HOST_A],
      ["New first.", HOST_B],
      ["Old tail.", HOST_A],
    ]);
    expect(fake.send.mock.calls[2][0].threadId).toBe("old-thread");
    expect(useVoiceSessionStore.getState().phase).toBe("live");
  });
});
