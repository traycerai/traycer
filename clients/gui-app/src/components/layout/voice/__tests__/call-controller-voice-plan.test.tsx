import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VoiceSelectionCapability } from "@traycer-clients/shared/host-client/voice-sessions";
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
import type { StoreApi } from "zustand";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { botConversationSendV13 } from "@traycer/protocol/host/bot/contracts";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotActivity,
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import type { ReplyRow } from "@/lib/voice/focused-replies";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";
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
  const capability: { current: VoiceSelectionCapability | null } = {
    current: null,
  };
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
    // Every answer SDP the engine was handed back by `exchangeSdp`.
    answers: [] as string[],
    // The one authority handle a call captures; opaque to the controller.
    authority: { opaque: "authority" },
    capture: vi.fn<() => object | null>(),
    mint: vi.fn<
      (
        request: {
          offerSdp: string;
          input: string;
          voice: string | null;
          voicePolicy: "fallback" | "exact" | null;
        },
        authority: object,
      ) => Promise<unknown>
    >(),
    endVoiceSession:
      vi.fn<(id: string, authority: object) => Promise<unknown>>(),
    // What the availability read answers for `voiceSelection`.
    capability,
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
    captureVoiceCallAuthority: fake.capture,
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
  useVoiceAvailabilityQuery: () => ({
    data: { available: true, voiceSelection: fake.capability.current },
  }),
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
        fake.answers.push(await input.exchangeSdp("offer"));
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
const SERVE_HERE: BotOpenResponse = {
  bot: BOT,
  outcome: { kind: "serve-here", claimed: null },
};

const CHANNEL_CALL: CallTarget = { botId: BOT_ID, threadId: null };

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

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets the promise chains the controller awaits settle, under fake timers. */
async function settle(): Promise<void> {
  await advance(0);
}

function driverOf() {
  const driver = useVoiceSessionStore.getState().driver;
  if (driver === null) throw new Error("the controller mounted no driver");
  return driver;
}

let rerenderController: (() => void) | null = null;

/**
 * What the availability read answers for `voiceSelection`, re-rendering the
 * controller as a real answer arriving would.
 */
function offerVoices(capability: VoiceSelectionCapability | null): void {
  fake.capability.current = capability;
  act(() => rerenderController?.());
}

async function dial(target: CallTarget): Promise<void> {
  act(() => driverOf().start(target));
  await settle();
}

async function dialLive(target: CallTarget): Promise<void> {
  await dial(target);
  expect(useVoiceSessionStore.getState().phase).toBe("live");
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
  fake.answers.length = 0;
  fake.capture.mockReset();
  fake.capture.mockImplementation(() => fake.authority);
  fake.capability.current = null;
  useSettingsStore.setState({ callVoice: null });
  fake.mint.mockReset();
  fake.mint.mockImplementation(() => Promise.resolve(minted("vs1", null)));
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
  const client = new QueryClient();
  const tree = (): ReactNode => (
    <QueryClientProvider client={client}>
      <CallController />
    </QueryClientProvider>
  );
  const view = render(tree());
  rerenderController = () => view.rerender(tree());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Selection =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "valid";
      readonly requestedVoice: string | null;
      readonly effectiveVoice: string;
      readonly reason: "selected" | "default" | "unavailable";
    };

const CAPABILITY: VoiceSelectionCapability = {
  version: 1,
  defaultVoice: "marin",
  voices: ["alloy", "cedar", "marin", "verse"],
  exactVoiceRenewal: true,
};

function valid(
  requestedVoice: string | null,
  effectiveVoice: string,
  reason: "selected" | "default" | "unavailable",
): Selection {
  return { kind: "valid", requestedVoice, effectiveVoice, reason };
}

/** A mint answer `ok` for session `id`; `null` is a server that names no voice. */
function minted(id: string, selection: Selection | null): unknown {
  return {
    kind: "ok",
    session: {
      voiceSessionId: id,
      answerSdp: "answer",
      expiresAt: Date.now() + 7_200_000,
      acknowledgementLines: ["Okay.", "One moment.", "Got it."],
      voiceSelection: selection ?? { kind: "absent" },
    },
  };
}

/** The call's next mints answer these, in order. */
function mintsAnswer(...answers: ReadonlyArray<unknown>): void {
  for (const answer of answers) fake.mint.mockResolvedValueOnce(answer);
}

function mintRequest(index: number): unknown {
  return fake.mint.mock.calls[index]?.[0];
}

/** The engine's session closes with time left: the call is renewed on a new session. */
async function renew(): Promise<void> {
  act(() => events().onClosed("connection"));
  await settle();
}

describe("the voice a call asks for", () => {
  it("asks for the saved voice with the fallback policy on a server that offers a choice, and for none when none is saved", async () => {
    offerVoices(CAPABILITY);
    useSettingsStore.setState({ callVoice: "cedar" });
    mintsAnswer(minted("vs1", valid("cedar", "cedar", "selected")));
    await dialLive(CHANNEL_CALL);

    expect(mintRequest(0)).toMatchObject({
      voice: "cedar",
      voicePolicy: "fallback",
    });
    expect(fake.mint.mock.calls[0]?.[1]).toBe(fake.authority);

    act(() => driverOf().end());
    await settle();
    useSettingsStore.setState({ callVoice: null });
    mintsAnswer(minted("vs2", valid(null, "marin", "default")));
    await dialLive(CHANNEL_CALL);

    expect(mintRequest(1)).toMatchObject({ voice: null, voicePolicy: null });
  });

  it("asks for no voice on a server that offers no choice, says nothing is promised, and goes live without voice metadata", async () => {
    offerVoices(null);
    useSettingsStore.setState({ callVoice: "cedar" });
    await dialLive(CHANNEL_CALL);

    expect(mintRequest(0)).toMatchObject({ voice: null, voicePolicy: null });
    expect(useVoiceSessionStore.getState().voiceNotice).toEqual({
      kind: "legacy",
    });
    expect(fake.answers).toEqual(["answer"]);
  });
});

describe("a renewal keeps the voice the call opened with", () => {
  it("asks for that exact voice whatever the settings say by then", async () => {
    offerVoices(CAPABILITY);
    useSettingsStore.setState({ callVoice: "cedar" });
    mintsAnswer(
      minted("vs1", valid("cedar", "cedar", "selected")),
      minted("vs2", valid("cedar", "cedar", "selected")),
    );
    await dialLive(CHANNEL_CALL);

    useSettingsStore.setState({ callVoice: "verse" });
    await renew();

    expect(mintRequest(1)).toMatchObject({
      voice: "cedar",
      voicePolicy: "exact",
    });
    expect(useVoiceSessionStore.getState().phase).toBe("live");
  });

  it("keeps the fallback notice and renews on the default voice, not the one that was unavailable", async () => {
    offerVoices(CAPABILITY);
    useSettingsStore.setState({ callVoice: "cedar" });
    mintsAnswer(
      minted("vs1", valid("cedar", "marin", "unavailable")),
      minted("vs2", valid("marin", "marin", "selected")),
    );
    await dialLive(CHANNEL_CALL);
    expect(useVoiceSessionStore.getState().voiceNotice).toEqual({
      kind: "fallback",
      saved: "cedar",
      voice: "marin",
    });

    await renew();

    expect(mintRequest(1)).toMatchObject({
      voice: "marin",
      voicePolicy: "exact",
    });
    expect(useVoiceSessionStore.getState().voiceNotice).toEqual({
      kind: "fallback",
      saved: "cedar",
      voice: "marin",
    });
  });

  it.each<[string, Selection]>([
    ["names no voice", { kind: "absent" }],
    ["names another voice", valid("cedar", "cedar", "selected")],
  ])(
    "ends the call as unconfirmed, with no further mint, when the renewal's answer %s",
    async (_label, selection) => {
      offerVoices(CAPABILITY);
      mintsAnswer(
        minted("vs1", valid(null, "marin", "default")),
        minted("vs2", selection),
      );
      await dialLive(CHANNEL_CALL);

      await renew();

      const state = useVoiceSessionStore.getState();
      expect(state.phase).toBe("idle");
      expect(state.endReason).toBe("voice-unconfirmed");
      expect(fake.mint).toHaveBeenCalledTimes(2);
      expect(fake.answers).toEqual(["answer"]);
      expect(fake.endVoiceSession).toHaveBeenCalledWith("vs2", fake.authority);
    },
  );

  it("ends the call as unavailable, with no further mint, when the server no longer offers the voice", async () => {
    offerVoices(CAPABILITY);
    mintsAnswer(minted("vs1", valid(null, "marin", "default")), {
      kind: "voice-unavailable",
    });
    await dialLive(CHANNEL_CALL);

    await renew();

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.endReason).toBe("voice-unavailable");
    expect(fake.mint).toHaveBeenCalledTimes(2);
  });
});

describe("an opening whose voice cannot be confirmed", () => {
  it.each<[string, string | null, Selection]>([
    ["no voice metadata", null, { kind: "absent" }],
    ["unreadable voice metadata", "cedar", { kind: "invalid" }],
    [
      "a voice other than the one asked for",
      "cedar",
      valid("verse", "verse", "selected"),
    ],
    [
      "a selected voice that is not the requested one",
      "cedar",
      valid("cedar", "verse", "selected"),
    ],
    [
      "a fallback to a voice that is not the default",
      "cedar",
      valid("cedar", "verse", "unavailable"),
    ],
    [
      "a default voice that is not the server's",
      null,
      valid(null, "verse", "default"),
    ],
  ])(
    "refuses the call on %s: no answer reaches the engine, the id is ended, and nothing is minted again",
    async (_label, saved, selection) => {
      offerVoices(CAPABILITY);
      useSettingsStore.setState({ callVoice: saved });
      mintsAnswer(minted("vs1", selection));

      await dial(CHANNEL_CALL);

      const state = useVoiceSessionStore.getState();
      expect(state.phase).toBe("idle");
      expect(state.refusal).toBe("voice-unconfirmed");
      expect(fake.answers).toEqual([]);
      expect(fake.endVoiceSession).toHaveBeenCalledWith("vs1", fake.authority);
      expect(fake.mint).toHaveBeenCalledTimes(1);
    },
  );
});
