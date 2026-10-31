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
import type {
  BotActivity,
  BotListResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { MockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import type { ReplyRow } from "@/lib/voice/focused-replies";
import type { HydrationRow } from "@/lib/voice/queue-sources";
import { runVoiceQueueVerb } from "@/lib/voice/queue-verbs";
import { MOVED_ASK_TEXT } from "@/lib/voice/say-loop";
import { voiceMutationKeys } from "@/lib/query-keys";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
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

/** The part of the voice's stream the controller switches. */
interface FakeRemoteStream {
  getAudioTracks(): ReadonlyArray<{ enabled: boolean }>;
}

interface ConnectInput {
  readonly exchangeSdp: (offer: string) => Promise<string>;
  readonly onRemoteAudio: (remote: FakeRemoteStream) => void;
  readonly events: VoiceEngineEvents;
}

interface FakeEngine {
  events: VoiceEngineEvents | null;
  onRemoteAudio: ((remote: FakeRemoteStream) => void) | null;
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
  anchorThread: null,
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
  // The voice's sound as the peer hands it over.
  const remoteTrack = { kind: "audio", enabled: true };
  const remoteStream = {
    getTracks: () => [remoteTrack],
    getAudioTracks: () => [remoteTrack],
  };
  // The bot's thread list as the selection sync reads it: `undefined` until
  // it answers; `set` answers it and re-renders the readers.
  let threadListValue: unknown = undefined;
  const threadListListeners = new Set<() => void>();
  const threadList = {
    get: (): unknown => threadListValue,
    subscribe: (listener: () => void): (() => void) => {
      threadListListeners.add(listener);
      return () => threadListListeners.delete(listener);
    },
    set: (value: unknown): void => {
      threadListValue = value;
      for (const listener of threadListListeners) listener();
    },
  };
  // The personal environment as `usePersonalEnvironment` answers it: resolved
  // to env-1 unless a test says it has not answered.
  const personalEnvironment = {
    value: { environmentId: "env-1", resolved: true, retry: () => undefined },
    pending: () => {
      personalEnvironment.value = {
        environmentId: "",
        resolved: false,
        retry: () => undefined,
      };
    },
    resolved: () => {
      personalEnvironment.value = {
        environmentId: "env-1",
        resolved: true,
        retry: () => undefined,
      };
    },
  };
  // The attention tier as the voice reads it (`useVoiceAttention`): no
  // unread replies or prompts unless a test sets them; `set` re-renders.
  const noAttention = {
    answers: [] as ReadonlyArray<unknown>,
    prompts: {
      approvals: [] as ReadonlyArray<string>,
      questions: [] as ReadonlyArray<string>,
    },
  };
  let attentionValue = noAttention;
  const attentionListeners = new Set<() => void>();
  const attention = {
    get: () => attentionValue,
    subscribe: (listener: () => void): (() => void) => {
      attentionListeners.add(listener);
      return () => attentionListeners.delete(listener);
    },
    set: (value: typeof noAttention): void => {
      attentionValue = value;
      for (const listener of attentionListeners) listener();
    },
    reset: (): void => {
      attentionValue = noAttention;
    },
  };
  // Each bot's activity as `useBotActivity` answers it: none unless a test
  // sets it; `set` and `remove` re-render the readers.
  const activityByBot = new Map<string, BotActivity>();
  const activityListeners = new Set<() => void>();
  const notifyActivity = (): void => {
    for (const listener of activityListeners) listener();
  };
  const activity = {
    get: (botId: string): BotActivity | null =>
      activityByBot.get(botId) ?? null,
    subscribe: (listener: () => void): (() => void) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    set: (botId: string, value: BotActivity): void => {
      activityByBot.set(botId, value);
      notifyActivity();
    },
    remove: (botId: string): void => {
      activityByBot.delete(botId);
      notifyActivity();
    },
    clear: (): void => {
      activityByBot.clear();
    },
  };
  function slot<T>(): { value: T | null } {
    return { value: null };
  }
  // Each bot's channel as `bot.conversation.list` answers it (bot-1's is
  // chan-1, bot-2's chan-bot-2); `answer(botId, false)` leaves a bot's list
  // unanswered until a test answers it, re-rendering its readers.
  const answeredLists = new Set(["bot-1", "bot-2"]);
  const listAnswers = new Map(
    ["bot-1", "bot-2"].map((botId) => [
      botId,
      {
        data: {
          conversations: [
            {
              conversationId: botId === "bot-1" ? "chan-1" : `chan-${botId}`,
              botId,
              title: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
    ]),
  );
  const unanswered = { data: undefined };
  const listListeners = new Set<() => void>();
  const conversationLists = {
    get: (botId: string) =>
      answeredLists.has(botId)
        ? (listAnswers.get(botId) ?? unanswered)
        : unanswered,
    subscribe: (listener: () => void): (() => void) => {
      listListeners.add(listener);
      return () => listListeners.delete(listener);
    },
    answer: (botId: string, answered: boolean): void => {
      if (answered) answeredLists.add(botId);
      else answeredLists.delete(botId);
      for (const listener of listListeners) listener();
    },
  };
  // The bot list as `bot.list` answers it, read by a real query over the
  // test's cache, so the change subscription's invalidation refetches it.
  const mainBotList: BotListResponse = {
    bots: [
      {
        botId: "bot-1",
        environmentId: "env-1",
        createdByUserId: "user-1",
        title: "CI bot",
        harness: "claude",
        model: "opus",
        effort: null,
        profile: null,
        trunkChatId: "trunk-bot-1",
        boundHostId: "host-a",
        hostEpoch: 0,
        createdAt: 1_000,
        archivedAt: null,
        directive: null,
        replyMode: "direct",
        appConversationChatId: "chan-1",
      },
      {
        botId: "bot-2",
        environmentId: "env-1",
        createdByUserId: "user-1",
        title: "Release bot",
        harness: "claude",
        model: "opus",
        effort: null,
        profile: null,
        trunkChatId: "trunk-bot-2",
        boundHostId: "host-a",
        hostEpoch: 0,
        createdAt: 2_000,
        archivedAt: null,
        directive: null,
        replyMode: "direct",
        appConversationChatId: "chan-bot-2",
      },
    ],
    mainBotIds: { "env-1": "bot-1" },
  };
  // The router's fixture answer: post the whole utterance to `botId`'s
  // channel (or its `threadId`), or to the focus for `null`.
  function routePost(
    botId: string | null,
    threadId: string | null,
    body: string,
    uncertain: boolean,
  ): unknown {
    const segments = body.split(String.raw`\"segment\":`).length - 1;
    return {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                action: "post",
                target: {
                  environmentId: null,
                  botId,
                  threadId,
                  itemId: null,
                },
                span: { fromSegment: 0, toSegment: segments - 1 },
                uncertain,
                question: null,
                control: null,
              }),
            },
          ],
        },
      ],
    };
  }
  return {
    personalEnvironment,
    attention,
    activity,
    mainBotList,
    botList: { value: mainBotList },
    doorbell: slot<MockWsStreamClient<StreamFrameEnvelope>>(),
    threadList,
    deferred,
    track,
    stream,
    remoteTrack,
    remoteStream,
    micAccess: deferred<string>(),
    media: deferred<typeof stream>(),
    send: deferred<unknown>(),
    sendMock: vi.fn(),
    markRead: vi.fn(),
    setVoiceSessionLive: vi.fn(),
    setVoiceSessionIndicator: vi.fn(),
    // The shell item's action handler the controller subscribed, if any.
    trayAction: {
      handler: null as
        | ((
            action:
              | { readonly kind: "setMuted"; readonly muted: boolean }
              | { readonly kind: "end" },
          ) => void)
        | null,
    },
    endVoiceSession: vi.fn(),
    engines: [] as FakeEngine[],
    handles: new Map<string, { store: StoreApi<ChatState> }>(),
    /**
     * The router's answer for these cases: every utterance posts, whole, to
     * the focus, which is what the say loop's post path they pin needs.
     */
    routeToFocus: (body: string): unknown => routePost(null, null, body, false),
    /** A router answer for one case, in place of {@link routeToFocus}; reset for every case. */
    routeAnswer: null as ((body: string) => unknown) | null,
    /**
     * What the router's navigate resolves with for the next tab navigation:
     * a settled navigation by default; a test makes it fail.
     */
    navigateOutcome: (): Promise<void> => Promise.resolve(),
    navigate: vi.fn((_options: unknown): Promise<void> =>
      fake.navigateOutcome(),
    ),
    /**
     * How the tab navigation takes the voice's next activation: `"switches"`
     * (the tab comes to the front at once and the route navigation runs; a
     * rejected one puts the previous tab back), `"queued"` (accepted before
     * the navigation is ready: nothing moves yet) or `"refused"`.
     */
    tabActivation: "switches",
    conversationLists,
    /** The answer that posts the whole utterance to bot `botId`'s channel. */
    routeToBot: (botId: string, body: string): unknown =>
      routePost(botId, null, body, false),
    /** A post to `botId`'s channel the router is unsure of: it is confirmed first. */
    routeToBotUnsure: (botId: string, body: string): unknown =>
      routePost(botId, null, body, true),
    routeToThread: (botId: string, threadId: string, body: string): unknown =>
      routePost(botId, threadId, body, false),
    /** Each bot's threads as `bot.thread.list` answers the voice's directory. */
    botThreads: new Map<string, ReadonlyArray<unknown>>(),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    requestMicrophoneAccess: () => fake.micAccess.promise,
    onSystemSuspended: () => ({ dispose: () => undefined }),
    setVoiceSessionLive: fake.setVoiceSessionLive,
    setVoiceSessionIndicator: fake.setVoiceSessionIndicator,
    onVoiceTrayAction: (
      handler: NonNullable<typeof fake.trayAction.handler>,
    ) => {
      fake.trayAction.handler = handler;
      return {
        dispose: () => {
          if (fake.trayAction.handler === handler) {
            fake.trayAction.handler = null;
          }
        },
      };
    },
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
    routeVoiceUtterance: (body: string) =>
      Promise.resolve({
        kind: "ok",
        body: (fake.routeAnswer ?? fake.routeToFocus)(body),
      }),
  }),
  useHostClient: () => null,
}));
// The router's directory is the real one, over the bot list above and the
// person's one environment as `environment.list` answers it.
const ENVIRONMENT_LIST = {
  data: {
    environments: [
      {
        environmentId: "env-1",
        ownerKind: "user" as const,
        ownerId: "user-1",
        roomId: "room-env-1",
        label: "Personal",
        effectiveRole: "owner" as const,
        kind: "personal" as const,
        hostCount: 1,
        providerHandle: null,
      },
    ],
  },
};
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ENVIRONMENT_LIST,
}));

// The host queries the voice's directory makes: `bot.thread.list` answers
// from `botThreads` (none by default); the follow, cursor and level reads
// have not answered.
vi.mock("@/hooks/host/use-host-queries", () => {
  function result(data: unknown): unknown {
    const settled = {
      data,
      isError: false,
      isPending: data === undefined,
      refetch: () => Promise.resolve(settled),
    };
    return settled;
  }
  return {
    useHostQueries: (args: {
      readonly requests: ReadonlyArray<{
        readonly method: string;
        readonly params: { readonly botId: string };
      }>;
    }) =>
      args.requests.map((request) =>
        result(
          request.method === "bot.thread.list"
            ? {
                threads: fake.botThreads.get(request.params.botId) ?? [],
                trunkCostUsd: null,
              }
            : undefined,
        ),
      ),
  };
});
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

/** The app-wide stream the `bot.listChanged` doorbell rides, reporting the method supported. */
class ServingStreamClient extends MockWsStreamClient<StreamFrameEnvelope> {
  override getMethodSupport(): StreamMethodSupport {
    return "supported";
  }

  override subscribeMethodSupport(): () => void {
    return () => undefined;
  }
}
const CHANGED: StreamFrameEnvelope = {
  kind: "changed",
  hasBinaryPayload: false,
};

vi.mock("@/hooks/bots/use-bot-list-query", async () => {
  const { queryOptions, useQuery } = await import("@tanstack/react-query");
  const { hostQueryKeys } = await import("@/lib/query-keys");
  return {
    useBotListQuery: (_client: unknown, enabled: boolean) =>
      useQuery(
        queryOptions<BotListResponse>({
          queryKey: hostQueryKeys.methodScope("host-a", "bot.list"),
          queryFn: () => Promise.resolve(fake.botList.value),
          initialData: fake.botList.value,
          enabled,
        }),
      ),
  };
});
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamHostId: () => "host-a",
  useWsStreamClient: () => fake.doorbell.value,
}));
vi.mock(
  "@/hooks/environment/use-addressed-environment",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/environment/use-addressed-environment")
    >()),
    usePersonalEnvironment: () => fake.personalEnvironment.value,
  }),
);
vi.mock("@/hooks/bots/use-bot-conversation-list-query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useBotConversationListQuery: (_client: unknown, botId: string) =>
      useSyncExternalStore(fake.conversationLists.subscribe, () =>
        fake.conversationLists.get(botId),
      ),
  };
});
vi.mock("@/hooks/bots/use-bot-thread-list-query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useBotThreadListQuery: () => ({
      data: useSyncExternalStore(
        fake.threadList.subscribe,
        fake.threadList.get,
      ),
    }),
  };
});
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({ mutateAsync: fake.sendMock }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: fake.markRead }),
  }),
);
vi.mock("@/hooks/voice/use-voice-attention", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useVoiceAttention: () =>
      useSyncExternalStore(fake.attention.subscribe, fake.attention.get),
  };
});
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
    useBotActivity: (botId: string) =>
      useSyncExternalStore(fake.activity.subscribe, () =>
        fake.activity.get(botId),
      ),
  };
});
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
      onRemoteAudio: null,
      started: fake.deferred<void>(),
      connect: vi.fn<(input: ConnectInput) => Promise<void>>(async (input) => {
        engine.events = input.events;
        engine.onRemoteAudio = input.onRemoteAudio;
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
// The tab navigation's activation as the real one behaves for the voice: it
// brings the bot's tab to the front at once and runs the route navigation
// (whose outcome `navigateOutcome` decides), putting the previous tab back
// when that navigation fails unless a newer activation superseded it; or it
// queues the activation, or refuses it.
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const { useTabsStore: tabs } = await import("@/stores/tabs/store");
  let activations = 0;
  return {
    ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
    activateTabIntent: (
      navigate: (options: object) => Promise<void>,
      intent: { readonly kind: string; readonly botId?: string },
      options: { readonly onRejected?: (error: Error) => void } | undefined,
    ): boolean => {
      if (fake.tabActivation === "refused") {
        options?.onRejected?.(new Error("refused"));
        return false;
      }
      if (fake.tabActivation === "queued") return true;
      const before = tabs.getState();
      const botId = intent.botId ?? "";
      // A newer activation supersedes this one: the tab navigation then
      // drops it, and its failure later puts nothing back.
      activations += 1;
      const activation = activations;
      tabs.setState({
        items: [
          ...before.items.filter((item) => item.id !== `item-${botId}`),
          { kind: "tab", id: `item-${botId}`, ref: { kind: "bot", id: botId } },
        ],
        activeItemId: `item-${botId}`,
      });
      void navigate({}).catch(() => {
        if (activation !== activations) return;
        tabs.setState({
          items: before.items,
          activeItemId: before.activeItemId,
        });
      });
      return true;
    },
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fake.navigate,
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

/** A member row whose request `requestId` is still open: nothing has resolved it. */
function openRequestRow(messageId: string, requestId: string): ReplyRow {
  return {
    role: "user",
    messageId,
    timestamp: Date.now(),
    conversationRequest: {
      requestId,
      resolvedAt: null,
      resolvedByMessageId: null,
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

let queryClient = new QueryClient();

function renderController(): void {
  queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
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
  fake.threadList.set(undefined);
  fake.attention.reset();
  fake.activity.clear();
  fake.personalEnvironment.resolved();
  fake.botList.value = fake.mainBotList;
  fake.doorbell.value = new ServingStreamClient();
  fake.track.stop.mockClear();
  fake.track.enabled = true;
  fake.remoteTrack.enabled = true;
  fake.setVoiceSessionLive.mockReset();
  fake.setVoiceSessionLive.mockImplementation(() => Promise.resolve());
  fake.setVoiceSessionIndicator.mockReset();
  fake.setVoiceSessionIndicator.mockImplementation(() => Promise.resolve());
  fake.endVoiceSession.mockReset();
  fake.endVoiceSession.mockImplementation(() =>
    Promise.resolve({ kind: "ok", closedAt: 1 }),
  );
  fake.routeAnswer = null;
  fake.navigateOutcome = () => Promise.resolve();
  fake.navigate.mockClear();
  fake.conversationLists.answer("bot-1", true);
  fake.conversationLists.answer("bot-2", true);
  fake.tabActivation = "switches";
  fake.botThreads.clear();
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
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      askState: "asking",
    });

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
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      askState: "asking",
    });

    // Each unconfirmed append spends its confirm window; stop at the third.
    for (let step = 0; step < 400 && askCount() < 3; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(askCount()).toBe(3);
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      askState: "asking",
    });

    // Just before the third window ends the person is still mid-utterance.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_900);
    });
    act(() => eventsOf(0).onInputTranscriptDelta("the branch."));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      askState: "closing",
    });

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

describe("a routed post to another bot", () => {
  it("opens that bot, sends only once its channel is known and never on the previous bot's, and the voice's own tab change is no move", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    await bringLive();
    expect(useVoiceSessionStore.getState().focus).toEqual(CHANNEL_FOCUS);
    fake.routeAnswer = (body) => fake.routeToBot("bot-2", body);
    act(() => fake.conversationLists.answer("bot-2", false));
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Ask the release bot when the train leaves.", "d1");

    // The voice moved to bot-2 and its tab came up: the focus is bot-2's
    // channel, not a move, and nothing is sent while its channel is unknown.
    expect(useVoiceSessionStore.getState().focus).toEqual({
      ...CHANNEL_FOCUS,
      botId: "bot-2",
    });
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation,
    );
    expect(fake.sendMock).not.toHaveBeenCalled();

    act(() => fake.conversationLists.answer("bot-2", true));
    await settle();

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith({
      botId: "bot-2",
      conversationId: "chan-bot-2",
      text: "Ask the release bot when the train leaves.",
      threadId: null,
      announcementId: null,
      redeliver: null,
      supersedes: null,
      answer: null,
    });
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(
      (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(
        ([text]) => text === MOVED_ASK_TEXT,
      ),
    ).toEqual([]);
  });

  it.each([
    ["refused by the tab navigation", "refused" as const],
    ["undone when its route navigation fails", "switches" as const],
  ])(
    "whose move is %s keeps the focus and the generation, posts nothing, and says the move did not happen",
    async (_name, activation) => {
      addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
      selectBotTab(BOT_ID);
      await bringLive();
      fake.routeAnswer = (body) => fake.routeToBot("bot-2", body);
      fake.tabActivation = activation;
      fake.navigateOutcome = () => Promise.reject(new Error("blocked"));
      const generation = useVoiceSessionStore.getState().selectionGeneration;

      await say("Ask the release bot when the train leaves.", "d1");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      const state = useVoiceSessionStore.getState();
      expect(state.focus).toEqual(CHANNEL_FOCUS);
      expect(state.selectionGeneration).toBe(generation);
      expect(state.segments).toEqual([]);
      expect(fake.sendMock).not.toHaveBeenCalled();
      expect(
        (fake.engines[0]?.appendCommentary.mock.calls ?? []).some(([text]) =>
          text.includes("did not happen"),
        ),
      ).toBe(true);
    },
  );
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

  it("is spoken once when the first snapshot holds the answer before the request resolves to it", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: false, messages: [] });
    await bringLive();
    focusOn(THREAD_FOCUS);
    await say("Update it.", "d1");
    await act(async () => {
      fake.send.resolve(FOLLOW_UP);
      await vi.advanceTimersByTimeAsync(0);
    });

    // The answer is in the snapshot, but nothing ties it to r1 yet: the
    // baseline takes it for history.
    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [
          botRow("h0", "Old news about the release."),
          openRequestRow("u1", "r1"),
          botRow("a1", "Merged."),
        ],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fake.engines[0]?.appendCommentary).not.toHaveBeenCalled();

    // The request records resolve r1 to that row.
    act(() => {
      thread.setState({ snapshotLoaded: true, messages: coldSnapshot() });
    });

    await expectOneAnswer();
  });
});

describe("an end route that throws", () => {
  it("during a re-mint is logged, and the replacement engine still starts", async () => {
    await bringLive();
    fake.endVoiceSession.mockImplementation(() =>
      Promise.reject(new Error("bridge failed")),
    );

    act(() => eventsOf(0).onClosed("vendor"));
    await settle();

    expect(fake.endVoiceSession).toHaveBeenCalledWith("vs1");
    expect(fake.engines).toHaveLength(2);
    await startEngine(1);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
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

describe("a channel announcement before a later top-level request", () => {
  it("is not spoken, and the request's actual answer takes its delegation", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await settle();
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
      expect.stringContaining("new build is complete"),
      "d1",
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("the new build is complete"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
  });
});

describe("a bot answering in its channel", () => {
  it("leaves an unrelated announcement unspoken, and speaks the answer under the delegation once the records name its request", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await say("Merge it.", "d1");
    await act(async () => {
      fake.send.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: null,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    const announcement = botRow("ann", "The nightly build finished.");
    act(() => {
      channel.setState({ snapshotLoaded: true, messages: [announcement] });
    });
    const commentary = fake.engines[0]?.appendCommentary;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).not.toHaveBeenCalled();

    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [
          announcement,
          requestRow("u1", "r1", "a2"),
          botRow("a2", "Merged."),
        ],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary.mock.calls).toEqual([
      [expect.stringContaining("Merged."), "d1"],
    ]);
    act(() => eventsOf(0).onOutputTranscriptDelta("merged"));
    await settle();
    // The confirmed answer marks the channel read, once.
    expect(fake.markRead.mock.calls).toEqual([
      [{ epicId: BOT_ID, chatId: CHANNEL_ID }],
    ]);
    expect(commentary).toHaveBeenCalledTimes(1);
  });
});

describe("dictation while a session is live", () => {
  it("pauses capture and the voice's sound, keeps the pause past dictation's end, and Resume re-enables both with the person's own mute kept", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    act(() => fake.engines[0]?.onRemoteAudio?.(fake.remoteStream));
    expect(fake.track.enabled).toBe(true);
    expect(fake.remoteTrack.enabled).toBe(true);

    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    expect(fake.track.enabled).toBe(false);
    expect(fake.remoteTrack.enabled).toBe(false);
    await say("Dear team, the invoice", "d1");
    expect(fake.sendMock).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().openSpan()).toBe("");
    expect(useVoiceSessionStore.getState().pendingDelegationId).toBeNull();

    // Dictation ends: the voice stays paused, and still hears nothing.
    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);
    expect(fake.track.enabled).toBe(false);
    expect(fake.remoteTrack.enabled).toBe(false);
    await say("Signed, the team", "d2");
    expect(fake.sendMock).not.toHaveBeenCalled();

    act(() => useVoiceSessionStore.getState().resumeFromDictation());
    expect(fake.track.enabled).toBe(true);
    expect(fake.remoteTrack.enabled).toBe(true);
    await say("Merge it.", "d3");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Merge it." }),
    );

    // Muted by the person: the pause and its Resume leave the mute in place.
    act(() => useVoiceSessionStore.getState().driver?.setMuted(true));
    expect(fake.track.enabled).toBe(false);
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    act(() => useVoiceSessionStore.getState().resumeFromDictation());
    expect(fake.track.enabled).toBe(false);
    expect(fake.remoteTrack.enabled).toBe(true);
    expect(useVoiceSessionStore.getState().muted).toBe(true);
    act(() => useVoiceSessionStore.getState().driver?.setMuted(false));
    expect(fake.track.enabled).toBe(true);
  });

  it("holds a reply that lands while paused until Resume, then speaks it", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: false, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await say("Merge it.", "d1");
    await act(async () => {
      fake.send.resolve(ACCEPTED);
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [botRow("a1", "Merged.")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).not.toHaveBeenCalled();

    act(() => useVoiceSessionStore.getState().resumeFromDictation());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("Merged."),
      "d1",
    );
  });
});

describe("a reply being spoken when dictation starts", () => {
  it("is not delivered or marked read by its silenced words, and is spoken again after Resume", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t1", { snapshotLoaded: false, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    await say("Merge it.", "d1");
    await act(async () => {
      fake.send.resolve(ACCEPTED);
      await vi.advanceTimersByTimeAsync(0);
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
    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).toHaveBeenCalledTimes(1);

    // Dictation starts before a word of the reply is heard; the engine goes
    // on transcribing the speech the paused speaker no longer plays.
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    act(() => eventsOf(0).onOutputTranscriptDelta("CI bot says merged"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fake.markRead).not.toHaveBeenCalled();
    expect(commentary).toHaveBeenCalledTimes(1);

    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    act(() => useVoiceSessionStore.getState().resumeFromDictation());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(2);
    expect(commentary).toHaveBeenLastCalledWith(
      expect.stringContaining("Merged."),
      "d1",
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("CI bot says merged"));
    expect(fake.markRead).toHaveBeenCalledWith({
      epicId: BOT_ID,
      chatId: "t1",
    });
  });
});

describe("the shell's voice item", () => {
  it("hears what the live session is doing, and its Mute and End act on the session", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    await settle();
    expect(fake.setVoiceSessionIndicator.mock.lastCall).toEqual([
      { muted: false, pausedForDictation: false },
    ]);

    act(() => useVoiceSessionStore.getState().driver?.setMuted(true));
    await settle();
    expect(fake.setVoiceSessionIndicator.mock.lastCall).toEqual([
      { muted: true, pausedForDictation: false },
    ]);
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    await settle();
    expect(fake.setVoiceSessionIndicator.mock.lastCall).toEqual([
      { muted: true, pausedForDictation: true },
    ]);
    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    act(() => useVoiceSessionStore.getState().resumeFromDictation());

    act(() => fake.trayAction.handler?.({ kind: "setMuted", muted: false }));
    expect(useVoiceSessionStore.getState().muted).toBe(false);
    expect(fake.track.enabled).toBe(true);

    act(() => fake.trayAction.handler?.({ kind: "end" }));
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.track.stop).toHaveBeenCalled();
    expect(fake.endVoiceSession).toHaveBeenCalledWith("vs1");
    expect(fake.setVoiceSessionLive.mock.lastCall).toEqual([false]);
  });

  it("reports a session that goes live under dictation as paused", async () => {
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    await bringLive();
    await settle();
    expect(fake.setVoiceSessionIndicator.mock.lastCall).toEqual([
      { muted: false, pausedForDictation: true },
    ]);
  });
});

describe("words open when dictation starts", () => {
  it("are let go: their boundary in the pause posts nothing, and the next request after it posts only its own words", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    focusOn(CHANNEL_FOCUS);
    act(() => eventsOf(0).onInputTranscriptDelta("Delete branch A. "));
    expect(useVoiceSessionStore.getState().openSpan()).toBe("Delete branch A.");

    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    expect(useVoiceSessionStore.getState().openSpan()).toBe("");
    await act(async () => {
      eventsOf(0).onDelegationCreated("d1");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.sendMock).not.toHaveBeenCalled();

    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    act(() => useVoiceSessionStore.getState().resumeFromDictation());
    await say("Check branch B.", "d2");
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Check branch B." }),
    );
  });
});

describe("a Talk ended and started again while dictation records", () => {
  it("starts with capture paused and drops its words until the person resumes after dictation", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    await bringLive();
    act(() => useVoiceSessionStore.getState().acquireDictationHold("composer"));
    expect(fake.track.enabled).toBe(false);

    act(() => useVoiceSessionStore.getState().driver?.end());
    await settle();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(useVoiceSessionStore.getState().pausedForDictation).toBe(true);

    // Talk again: the permission and the microphone answer as before.
    await startTalk();
    await settle();
    await startEngine(1);
    expect(useVoiceSessionStore.getState().phase).toBe("live");
    focusOn(CHANNEL_FOCUS);
    expect(fake.track.enabled).toBe(false);
    await act(async () => {
      eventsOf(1).onInputTranscriptDelta("Dear team,");
      eventsOf(1).onDelegationCreated("d1");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.sendMock).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().openSpan()).toBe("");

    act(() => useVoiceSessionStore.getState().releaseDictationHold("composer"));
    expect(fake.track.enabled).toBe(false);
    act(() => useVoiceSessionStore.getState().resumeFromDictation());
    expect(fake.track.enabled).toBe(true);
    await act(async () => {
      eventsOf(1).onInputTranscriptDelta("Merge it.");
      eventsOf(1).onDelegationCreated("d2");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("a Talk with no bot tab open", () => {
  it("goes to the personal environment's main bot and opens its tab, whatever the Show Tracy setting", async () => {
    // Show Tracy off: no fixed entry.
    expect(useBotTabsStore.getState().fixedBotId).toBeNull();
    expect(useVoiceSessionStore.getState().destinationKnown).toBe(true);
    await bringLive();

    expect(useVoiceSessionStore.getState().focus).toEqual(CHANNEL_FOCUS);
    expect(useBotTabsStore.getState().tabs[BOT_ID]).toMatchObject({
      hostId: "host-a",
      title: "CI bot",
    });
    expect(useBotTabsStore.getState().fixedBotId).toBeNull();
  });

  it("does not start while no main bot is known: Talk is disabled and nothing is minted", async () => {
    // The environment has not answered when this window's controller mounts.
    fake.personalEnvironment.pending();
    cleanup();
    renderController();
    await settle();
    expect(useVoiceSessionStore.getState().destinationKnown).toBe(false);

    await startTalk();
    await grantMicrophone();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.engines).toEqual([]);
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: voiceMutationKeys.mint() }),
    ).toEqual([]);
  });
});

describe("the bot list changing elsewhere", () => {
  /** Rings the shared `bot.listChanged` doorbell the controller joined, and lets the refetch land. */
  async function ringListChanged(): Promise<void> {
    const doorbell = fake.doorbell.value?.getSession("bot.listChanged", {});
    if (doorbell === undefined) throw new Error("bot.listChanged not joined");
    await act(async () => {
      doorbell.emitFrame(CHANGED);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("enables Talk once a main bot created elsewhere reaches the list, with no Tracy entry and no Home", async () => {
    fake.botList.value = { bots: [], mainBotIds: {} };
    cleanup();
    renderController();
    await settle();
    expect(useVoiceSessionStore.getState().destinationKnown).toBe(false);

    fake.botList.value = fake.mainBotList;
    await ringListChanged();

    expect(useVoiceSessionStore.getState().destinationKnown).toBe(true);
    await bringLive();
    expect(useVoiceSessionStore.getState().focus).toEqual(CHANNEL_FOCUS);
  });

  it("disables Talk once the main bot is archived elsewhere, and refuses to start to it", async () => {
    expect(useVoiceSessionStore.getState().destinationKnown).toBe(true);
    const [main] = fake.mainBotList.bots;
    fake.botList.value = {
      bots: [{ ...main, archivedAt: 2_000 }],
      mainBotIds: { "env-1": "bot-1" },
    };
    await ringListChanged();

    expect(useVoiceSessionStore.getState().destinationKnown).toBe(false);
    await startTalk();
    expect(useVoiceSessionStore.getState().phase).toBe("idle");
    expect(fake.engines).toEqual([]);
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: voiceMutationKeys.mint() }),
    ).toEqual([]);
  });
});

describe("the voice routes", () => {
  it("mint, end, the microphone prompt and the shell flag run as keyed mutations the cache holds, awaited by the attempt", async () => {
    await bringLive();
    const cache = queryClient.getMutationCache();
    const statusesOf = (mutationKey: ReadonlyArray<string>): string[] =>
      cache
        .findAll({ mutationKey })
        .map(
          (mutation) =>
            `${String(mutation.state.variables)}:${mutation.state.status}`,
        );
    expect(statusesOf(voiceMutationKeys.microphoneAccess())).toEqual([
      "undefined:success",
    ]);
    expect(statusesOf(voiceMutationKeys.shellLive())).toEqual(["true:success"]);
    const mints = cache.findAll({ mutationKey: voiceMutationKeys.mint() });
    expect(mints.map((mutation) => mutation.state.status)).toEqual(["success"]);
    expect(mints[0]?.state.variables).toEqual({
      offerSdp: "offer",
      input: "Nothing needs your attention right now.",
    });
    expect(cache.findAll({ mutationKey: voiceMutationKeys.end() })).toEqual([]);

    act(() => useVoiceSessionStore.getState().driver?.end());
    await settle();

    const ends = cache.findAll({ mutationKey: voiceMutationKeys.end() });
    expect(
      ends.map((mutation) => [mutation.state.variables, mutation.state.status]),
    ).toEqual([["vs1", "success"]]);
    expect(fake.endVoiceSession).toHaveBeenCalledWith("vs1");
    expect(statusesOf(voiceMutationKeys.shellLive())).toEqual([
      "true:success",
      "false:success",
    ]);
  });
});

describe("a run of sessions that die at once", () => {
  it("re-mints twice, then ends with connection and mints no more", async () => {
    await bringLive();
    const cache = queryClient.getMutationCache();

    for (const index of [0, 1]) {
      act(() => eventsOf(index).onClosed("vendor"));
      await settle();
      expect(fake.engines).toHaveLength(index + 2);
      await startEngine(index + 1);
      expect(useVoiceSessionStore.getState().phase).toBe("live");
    }
    act(() => eventsOf(2).onClosed("connection"));
    await settle();

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.endReason).toBe("connection");
    expect(fake.engines).toHaveLength(3);
    expect(
      cache.findAll({ mutationKey: voiceMutationKeys.mint() }),
    ).toHaveLength(3);
    expect(fake.endVoiceSession).toHaveBeenCalledTimes(3);
    expect(fake.track.stop).toHaveBeenCalled();
  });
});

describe("a question nobody has replied under", () => {
  function openQuestionRail(): void {
    selectBotTab(BOT_ID);
    act(() =>
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId: "q1",
        announcement: true,
        anchorKind: null,
        sent: null,
      }),
    );
  }
  const RESOLVING: VoiceFocus = {
    ...CHANNEL_FOCUS,
    anchorMessageId: "q1",
    anchorThread: "resolving",
  };

  it("holds a closed request until the thread list answers, then posts it under the question as the reply that opens its thread, follows that thread by the question, and posts the next request into it", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    openQuestionRail();
    await bringLive();
    expect(useVoiceSessionStore.getState().focus).toEqual(RESOLVING);
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Yes, merge it.", "d1");
    expect(fake.sendMock).not.toHaveBeenCalled();

    act(() => {
      fake.threadList.set({ threads: [] });
    });
    // The list resolving the anchor is not the person moving, and the
    // request closed while it was unresolved posts now, under its own
    // delegation.
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation,
    );
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Yes, merge it.",
        threadId: null,
        announcementId: "q1",
      }),
    );
    await act(async () => {
      fake.send.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: "tq",
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useVoiceSessionStore.getState().focus).toEqual({
      ...RESOLVING,
      threadId: "tq",
      anchorThread: null,
    });
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toMatchObject({
      kind: "thread",
      anchorMessageId: "q1",
      sent: null,
    });

    await say("Then deploy it.", "d2");
    expect(fake.sendMock).toHaveBeenCalledTimes(2);
    expect(fake.sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Then deploy it.",
        threadId: "tq",
        announcementId: null,
      }),
    );
  });

  it("posts a request closed while unresolved into the thread the list then names, once, and a later request on its own", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    addChat("t1", { snapshotLoaded: true, messages: [] });
    openQuestionRail();
    await bringLive();

    await say("Check the build.", "d1");
    expect(fake.sendMock).not.toHaveBeenCalled();
    act(() => eventsOf(0).onDelegationCreated("d1"));
    expect(fake.sendMock).not.toHaveBeenCalled();

    act(() => {
      fake.threadList.set({
        threads: [{ threadId: "t1", anchor: { messageId: "q1" } }],
      });
    });
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Check the build.",
        threadId: "t1",
        announcementId: null,
      }),
    );
    await act(async () => {
      fake.send.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: "t1",
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    await say("What failed?", "d2");
    expect(fake.sendMock).toHaveBeenCalledTimes(2);
    expect(fake.sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "What failed?", threadId: "t1" }),
    );
  });

  it("whose reply joined a thread the list had not shown speaks that thread's history to nobody, and the actual answer under the delegation", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t-existing", {
      snapshotLoaded: false,
      messages: [],
    });
    openQuestionRail();
    act(() => {
      fake.threadList.set({ threads: [] });
    });
    await bringLive();
    expect(useVoiceSessionStore.getState().focus).toEqual({
      ...RESOLVING,
      anchorThread: "unopened",
    });

    await say("Rebuild it.", "d1");
    await act(async () => {
      fake.send.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: "t-existing",
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useVoiceSessionStore.getState().focus?.threadId).toBe("t-existing");

    // The thread existed: its first snapshot is history.
    const old = botRow("old", "Yesterday branch alpha was deleted.");
    act(() => {
      thread.setState({ snapshotLoaded: true, messages: [old] });
    });
    const commentary = fake.engines[0]?.appendCommentary;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).not.toHaveBeenCalled();

    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [
          old,
          requestRow("u1", "r1", "a2"),
          botRow("a2", "The new build passed."),
        ],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary.mock.calls).toEqual([
      [expect.stringContaining("The new build passed."), "d1"],
    ]);
    act(() => eventsOf(0).onOutputTranscriptDelta("the new build passed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(fake.markRead.mock.calls).toEqual([
      [{ epicId: BOT_ID, chatId: "t-existing" }],
    ]);
  });
});

describe("a replacement asked for before its session started", () => {
  it("is not taken, and does not reset the short-session budget", async () => {
    await bringLive();

    act(() => eventsOf(0).onClosed("vendor"));
    await settle();
    expect(fake.engines).toHaveLength(2);
    // The new session reports high usage before it has started.
    act(() => eventsOf(1).onUsage({ seconds: 1, contextUsageRatio: 0.95 }));
    await settle();
    expect(fake.engines).toHaveLength(2);
    await startEngine(1);
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    act(() => eventsOf(1).onClosed("vendor"));
    await settle();
    await startEngine(2);
    act(() => eventsOf(2).onClosed("vendor"));
    await settle();

    const state = useVoiceSessionStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.endReason).toBe("connection");
    expect(fake.engines).toHaveLength(3);
    expect(fake.endVoiceSession).toHaveBeenCalledTimes(3);
  });
});

describe("a reply elsewhere", () => {
  const ANSWER = {
    messageId: "r-2",
    botId: "bot-2",
    threadId: "thread-x",
    chatId: "thread-x",
    originHostId: "host-a",
    at: Date.now(),
    blocking: false,
  };
  const NO_PROMPTS = { approvals: [], questions: [] };

  it("waiting before Talk is briefed in the mint's input and queued without an offer", async () => {
    addChat("thread-x", {
      snapshotLoaded: true,
      messages: [botRow("r-2", "The Safari fix landed in build forty.")],
    });
    act(() => fake.attention.set({ answers: [ANSWER], prompts: NO_PROMPTS }));

    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const mints = queryClient
      .getMutationCache()
      .findAll({ mutationKey: voiceMutationKeys.mint() });
    expect(mints[0]?.state.variables).toEqual({
      offerSdp: "offer",
      input:
        "Here is what needs your attention. Release bot answered in a thread.",
    });
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.id),
    ).toEqual(["r-2"]);
    expect(fake.engines[0]?.appendCommentary).not.toHaveBeenCalled();
  });

  it("that arrives while live is offered once, read on request, and marks its thread read once said", async () => {
    await bringLive();
    addChat("thread-x", {
      snapshotLoaded: true,
      messages: [botRow("r-2", "The Safari fix landed in build forty.")],
    });
    act(() => fake.attention.set({ answers: [ANSWER], prompts: NO_PROMPTS }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("Want it?"),
      null,
    );

    // The voice says the offer; only then can the read go ahead of anything.
    act(() =>
      eventsOf(0).onOutputTranscriptDelta(
        "The bot answered in a thread, the Safari fix landed.",
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => {
      runVoiceQueueVerb({ kind: "read", itemId: "r-2", delegationId: null });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(2);
    expect(commentary).toHaveBeenLastCalledWith(
      expect.stringContaining("Safari"),
      null,
    );
    expect(fake.markRead).not.toHaveBeenCalled();

    act(() => eventsOf(0).onOutputTranscriptDelta("The Safari fix landed"));
    await settle();

    expect(fake.markRead.mock.calls).toEqual([
      [{ epicId: "bot-2", chatId: "thread-x" }],
    ]);
  });
});

/** A teammate's message in a thread, as the records hold it. */
type TeammateRow = Extract<HydrationRow, { readonly role: "user" }> & {
  readonly timestamp: number;
};

function teammateRow(
  messageId: string,
  text: string,
  userId: string,
): TeammateRow {
  return {
    role: "user",
    messageId,
    timestamp: Date.now(),
    sender: { type: "user", userId },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      browserAnnotations: [],
    },
  };
}

describe("a voice switch to a thread", () => {
  const ANSWER = {
    messageId: "r-9",
    botId: BOT_ID,
    threadId: "t-9",
    chatId: "t-9",
    originHostId: "host-a",
    at: Date.now(),
    blocking: false,
  };

  async function switchToThread(): Promise<void> {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    addChat("t-9", {
      snapshotLoaded: true,
      messages: [botRow("r-9", "Deployed.")],
    });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await bringLive();
    act(() =>
      fake.attention.set({
        answers: [ANSWER],
        prompts: { approvals: [], questions: [] },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    act(() => {
      runVoiceQueueVerb({
        kind: "switch",
        target: { kind: "item", itemId: "r-9" },
      });
    });
    expect(useVoiceSessionStore.getState().focus?.threadId).toBe("t-9");
  }

  function openAnchor(anchorMessageId: string): void {
    act(() =>
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId,
        announcement: true,
        anchorKind: null,
        sent: null,
      }),
    );
  }

  it("does not swallow the person opening another anchor of the bot once the tab has spent the landing", async () => {
    await switchToThread();
    act(() => useBotTabLandingStore.setState({ byBotId: {} }, false));

    openAnchor("q-other");
    await settle();

    expect(useVoiceSessionStore.getState().focus?.anchorMessageId).toBe(
      "q-other",
    );
  });

  it("does not swallow the person opening an anchor other than the one the rail held, before the landing is spent", async () => {
    await switchToThread();
    expect(Object.keys(useBotTabLandingStore.getState().byBotId)).toEqual([
      BOT_ID,
    ]);

    openAnchor("q-other");
    await settle();

    expect(useVoiceSessionStore.getState().focus?.anchorMessageId).toBe(
      "q-other",
    );
  });
});

describe("what waits at Talk", () => {
  it("keeps an unread answer already in the focused channel as a queue item, unspoken", async () => {
    addChat(CHANNEL_ID, {
      snapshotLoaded: true,
      messages: [botRow("r-2", "The Safari fix landed in build forty.")],
    });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    act(() =>
      fake.attention.set({
        answers: [
          {
            messageId: "r-2",
            botId: BOT_ID,
            threadId: null,
            chatId: CHANNEL_ID,
            originHostId: "host-a",
            at: Date.now(),
            blocking: false,
          },
        ],
        prompts: { approvals: [], questions: [] },
      }),
    );

    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.id),
    ).toEqual(["r-2"]);
    expect(fake.engines[0]?.appendCommentary).not.toHaveBeenCalled();
  });

  it("hydrates a teammate's message in a followed thread as a message, read by what they wrote", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    addChat("thread-x", {
      snapshotLoaded: true,
      messages: [teammateRow("tm-1", "Ship it Friday", "u-9")],
    });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    act(() =>
      fake.attention.set({
        answers: [
          {
            messageId: "tm-1",
            botId: "bot-2",
            threadId: "thread-x",
            chatId: "thread-x",
            originHostId: "host-a",
            at: Date.now(),
            blocking: false,
          },
        ],
        prompts: { approvals: [], questions: [] },
      }),
    );

    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(
      useVoiceSessionStore
        .getState()
        .queue.map((item) => [item.id, item.kind, item.author]),
    ).toEqual([["tm-1", "message", null]]);
    act(() => {
      runVoiceQueueVerb({ kind: "read", itemId: "tm-1", delegationId: null });
    });
    expect(fake.engines[0]?.appendCommentary).toHaveBeenCalledWith(
      "A teammate said: Ship it Friday",
      null,
    );
  });
});

describe("an announcement on the focused channel", () => {
  it("is not spoken as it lands, and the queue keeps it for a briefing", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    // The bot posts on its own: no repliesTo, no member request resolved to it.
    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [botRow("ann-1", "Nightly build is red on main.")],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fake.engines[0]?.appendCommentary).not.toHaveBeenCalled();
    expect(
      useVoiceSessionStore.getState().queue.map((item) => [item.id, item.kind]),
    ).toEqual([["ann-1", "announcement"]]);
  });
});

describe("a bot's question at the focused channel's top level", () => {
  it("is spoken with its choices, and is not kept as an announcement, whichever record names it", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    // No repliesTo, no member request resolved to it: an open question.
    const question: Extract<ReplyRow, { readonly role: "assistant" }> = {
      role: "assistant",
      messageId: "q-1",
      timestamp: Date.now(),
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
    act(() => {
      channel.setState({ snapshotLoaded: true, messages: [question] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("The choices are: 1. Ship; 2. Hold."),
      null,
    );
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).not.toContain("announcement");

    act(() =>
      eventsOf(0).onOutputTranscriptDelta("CI bot asks: ready to release"),
    );

    // The notification names the same message, as a blocking row.
    act(() =>
      fake.attention.set({
        answers: [
          {
            messageId: "q-1",
            botId: BOT_ID,
            threadId: null,
            chatId: CHANNEL_ID,
            originHostId: "host-a",
            at: Date.now(),
            blocking: true,
          },
        ],
        prompts: { approvals: [], questions: ["q-1"] },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).not.toContain("announcement");
    expect(commentary).toHaveBeenCalledTimes(1);
  });
});

describe("an answer a bot stopped on, before Talk", () => {
  it("is named in the mint's input and queued as a failed item, with nothing else waiting", async () => {
    fake.activity.set(BOT_ID, {
      trunk: {
        state: "parked",
        startedAt: null,
        step: null,
        requestId: "req-7",
        reason: null,
      },
      threads: {},
    });
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);

    await bringLive();

    const mints = queryClient
      .getMutationCache()
      .findAll({ mutationKey: voiceMutationKeys.mint() });
    expect(mints[0]?.state.variables).toEqual({
      offerSdp: "offer",
      input:
        "Here is what needs your attention. CI bot stopped before answering in its channel.",
    });
    expect(
      useVoiceSessionStore.getState().queue.map((item) => [item.id, item.kind]),
    ).toEqual([["stopped:bot-1:req-7", "failed"]]);
  });
});

describe("a bot whose stream is gone before Talk", () => {
  const PARKED: BotActivity = {
    trunk: {
      state: "parked",
      startedAt: null,
      step: null,
      requestId: "req-7",
      reason: null,
    },
    threads: {},
  };

  it("leaves no stopped answer in the opening briefing or the queue", async () => {
    fake.activity.set(BOT_ID, PARKED);
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await settle();

    act(() => fake.activity.remove(BOT_ID));
    await settle();
    await bringLive();

    const mints = queryClient
      .getMutationCache()
      .findAll({ mutationKey: voiceMutationKeys.mint() });
    expect(mints[0]?.state.variables).toEqual({
      offerSdp: "offer",
      input: "Nothing needs your attention right now.",
    });
    expect(useVoiceSessionStore.getState().queue).toEqual([]);
  });
});

describe("a reply read through Waiting", () => {
  it("is not read again on returning to its thread", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    const thread = addChat("t-5", { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    await bringLive();
    const threadFocus: VoiceFocus = { ...CHANNEL_FOCUS, threadId: "t-5" };
    // The feed baselines the thread's loaded snapshot, then the person moves on.
    focusOn(threadFocus);
    await settle();
    focusOn(CHANNEL_FOCUS);
    await settle();

    act(() => {
      thread.setState({
        snapshotLoaded: true,
        messages: [botRow("r-t", "Merged the release branch.")],
      });
      fake.attention.set({
        answers: [
          {
            messageId: "r-t",
            botId: BOT_ID,
            threadId: "t-5",
            chatId: "t-5",
            originHostId: "host-a",
            at: Date.now(),
            blocking: false,
          },
        ],
        prompts: { approvals: [], questions: [] },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const commentary = fake.engines[0]?.appendCommentary;
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenLastCalledWith(
      expect.stringContaining("Want it?"),
      null,
    );
    act(() =>
      eventsOf(0).onOutputTranscriptDelta(
        "CI bot answered, merged the release",
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    act(() => {
      runVoiceQueueVerb({ kind: "read", itemId: "r-t", delegationId: null });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(2);
    expect(commentary).toHaveBeenLastCalledWith(
      "CI bot said: Merged the release branch.",
      null,
    );
    act(() => eventsOf(0).onOutputTranscriptDelta("Merged the release branch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    focusOn(threadFocus);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(commentary).toHaveBeenCalledTimes(2);
  });
});

describe("a rail change in the bot the voice is leaving", () => {
  it("counts as the person moving while the target's tab has not come up", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    await bringLive();
    fake.routeAnswer = (body) => fake.routeToBot("bot-2", body);
    // The activation is queued (the tab navigation is not ready yet): bot-1's
    // tab stays the active one while the voice's move is out.
    fake.tabActivation = "queued";
    await say("Ask the release bot when the train leaves.", "d1");
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    // The person opens a thread in bot-1's rail by hand.
    act(() =>
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId: "q1",
        announcement: true,
        anchorKind: null,
        sent: null,
      }),
    );
    await settle();

    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation + 1,
    );
  });
});

describe("a routed post to another thread of the active bot", () => {
  it("opens that thread, posts there once, and interrupts nothing while its navigation is out", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    fake.botThreads.set(BOT_ID, [
      {
        threadId: "t-safari",
        conversationId: CHANNEL_ID,
        sessionChatId: "session-safari",
        anchor: {
          messageId: "q-safari",
          requestId: "r-safari",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
        },
        replyCount: 2,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ]);
    selectBotTab(BOT_ID);
    await bringLive();
    let land: () => void = () => undefined;
    fake.navigateOutcome = () =>
      new Promise<void>((resolve) => {
        land = resolve;
      });
    fake.routeAnswer = (body) => fake.routeToThread(BOT_ID, "t-safari", body);
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Is the Safari fix in tonight's train?", "d1");

    // The rail moved to the thread at once; the navigation is still out, so
    // the new anchor is the voice's own and nothing is posted yet.
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toMatchObject({
      kind: "thread",
      anchorMessageId: "q-safari",
    });
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation,
    );
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(fake.sendMock).not.toHaveBeenCalled();

    await act(async () => {
      land();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: BOT_ID,
        conversationId: CHANNEL_ID,
        threadId: "t-safari",
        text: "Is the Safari fix in tonight's train?",
      }),
    );
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation,
    );
    expect(
      (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(
        ([text]) => text === MOVED_ASK_TEXT,
      ),
    ).toEqual([]);
  });
});

describe("a held voice navigation to another bot", () => {
  it("a rail change by the person in the tab the voice is opening, while its navigation is out, is a move", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    await bringLive();
    fake.routeAnswer = (body) => fake.routeToBot("bot-2", body);
    act(() => fake.conversationLists.answer("bot-2", true));
    let land: () => void = () => undefined;
    fake.navigateOutcome = () =>
      new Promise<void>((resolve) => {
        land = resolve;
      });
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Ask the release bot when the train leaves.", "d1");
    // bot-2's tab is already the active one; its navigation is still out.
    act(() =>
      useBotOpenThreadStore.getState().setRail("bot-2", {
        kind: "thread",
        anchorMessageId: "q1",
        announcement: true,
        anchorKind: null,
        sent: null,
      }),
    );
    await settle();

    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation + 1,
    );
    land();
    await settle();
    expect(fake.sendMock).not.toHaveBeenCalled();
  });
});

describe("two overlapping voice navigations", () => {
  it("when the older settles last, keep the focus on the newer destination, interrupt nothing, and post only the newer request", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    fake.botThreads.set(BOT_ID, [
      {
        threadId: "t-safari",
        conversationId: CHANNEL_ID,
        sessionChatId: "session-safari",
        anchor: {
          messageId: "q-safari",
          requestId: "r-safari",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
        },
        replyCount: 2,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ]);
    selectBotTab(BOT_ID);
    await bringLive();
    // The first request goes to bot-2's channel, the second to bot-1's
    // Safari thread; each navigation is held until the test lands it.
    const routes = [
      (body: string) => fake.routeToBot("bot-2", body),
      (body: string) => fake.routeToThread(BOT_ID, "t-safari", body),
    ];
    fake.routeAnswer = (body) => (routes.shift() ?? fake.routeToFocus)(body);
    const lands: Array<() => void> = [];
    fake.navigateOutcome = () =>
      new Promise<void>((resolve) => {
        lands.push(resolve);
      });
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Ask the release bot when the train leaves.", "d1");
    await say("Is the Safari fix in tonight's train?", "d2");
    expect(lands).toHaveLength(2);

    // The newer navigation lands first, then the superseded older one.
    await act(async () => {
      lands[1]?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      lands[0]?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();

    const state = useVoiceSessionStore.getState();
    expect(state.focus).toMatchObject({
      botId: BOT_ID,
      threadId: "t-safari",
      anchorMessageId: "q-safari",
    });
    expect(state.selectionGeneration).toBe(generation);
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: BOT_ID,
        threadId: "t-safari",
        text: "Is the Safari fix in tonight's train?",
      }),
    );
    expect(
      (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(
        ([text]) => text === MOVED_ASK_TEXT,
      ),
    ).toEqual([]);
  });
});

describe("a held voice move within the active bot", () => {
  it("the person closing the rail the voice just opened, back to the departing anchor, is a move", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    fake.botThreads.set(BOT_ID, [
      {
        threadId: "t-safari",
        conversationId: CHANNEL_ID,
        sessionChatId: "session-safari",
        anchor: {
          messageId: "q-safari",
          requestId: "r-safari",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
        },
        replyCount: 2,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ]);
    selectBotTab(BOT_ID);
    await bringLive();
    let land: () => void = () => undefined;
    fake.navigateOutcome = () =>
      new Promise<void>((resolve) => {
        land = resolve;
      });
    fake.routeAnswer = (body) => fake.routeToThread(BOT_ID, "t-safari", body);
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Is the Safari fix in tonight's train?", "d1");
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toMatchObject({
      anchorMessageId: "q-safari",
    });

    // The person closes the rail the voice opened: back to the channel the
    // voice departed from, while the navigation is still out.
    act(() => useBotOpenThreadStore.getState().setRail(BOT_ID, null));
    await settle();
    // The move is noticed while the navigation is still out.
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation + 1,
    );
    await act(async () => {
      land();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation + 1,
    );
    expect(fake.sendMock).not.toHaveBeenCalled();
  });
});

describe("a confirmation dropped before its question was said", () => {
  it("withdraws the question: a new request in its place leaves nothing asking about the dropped post", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    await bringLive();
    const routes = [
      (body: string) => fake.routeToBotUnsure("bot-2", body),
      (body: string) => fake.routeToFocus(body),
    ];
    fake.routeAnswer = (body) => (routes.shift() ?? fake.routeToFocus)(body);

    // The question waits behind the voice's own acknowledgement; before it
    // is said, the person makes a new request instead.
    await say("Tell the release bot hello.", "d1");
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "confirming",
    });
    await say("Check the build.", "d2");
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const said = (fake.engines[0]?.appendCommentary.mock.calls ?? []).map(
      ([text]) => text,
    );
    expect(said.some((text) => text.startsWith("Did you mean"))).toBe(false);
    expect(fake.sendMock).toHaveBeenCalledTimes(1);
    expect(fake.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID, text: "Check the build." }),
    );
  });

  it("a question that was appended but not confirmed is not appended again once a new request drops its confirmation", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    await bringLive();
    const routes = [
      (body: string) => fake.routeToBotUnsure("bot-2", body),
      (body: string) => fake.routeToFocus(body),
    ];
    fake.routeAnswer = (body) => (routes.shift() ?? fake.routeToFocus)(body);
    const questions = (): number =>
      (fake.engines[0]?.appendCommentary.mock.calls ?? []).filter(([text]) =>
        text.startsWith("Did you mean"),
      ).length;

    await say("Tell the release bot hello.", "d1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // The question was appended once, and its output never confirmed.
    expect(questions()).toBe(1);

    await say("Check the build.", "d2");
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(questions()).toBe(1);
  });
});

describe("a voice move to another thread of the active bot that fails", () => {
  it("puts the bot's rail back as it was, so nothing reads the failed move as the person's", async () => {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    fake.botThreads.set(BOT_ID, [
      {
        threadId: "t-safari",
        conversationId: CHANNEL_ID,
        sessionChatId: "session-safari",
        anchor: {
          messageId: "q-safari",
          requestId: "r-safari",
          senderUserId: "user-1",
          sentAt: 1_000,
          resolvedAt: null,
        },
        replyCount: 2,
        lastReplyAt: 2_000,
        openRequestCount: 0,
        costUsd: null,
      },
    ]);
    selectBotTab(BOT_ID);
    await bringLive();
    fake.routeAnswer = (body) => fake.routeToThread(BOT_ID, "t-safari", body);
    fake.navigateOutcome = () => Promise.reject(new Error("blocked"));
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Is the Safari fix in tonight's train?", "d1");
    await settle();

    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toBeUndefined();
    const state = useVoiceSessionStore.getState();
    expect(state.focus).toEqual(CHANNEL_FOCUS);
    expect(state.selectionGeneration).toBe(generation);
    expect(fake.sendMock).not.toHaveBeenCalled();
  });
});

describe("a rail put back against a newer navigation", () => {
  const THREAD_RAIL = {
    kind: "thread",
    anchorMessageId: "q-safari",
    announcement: false,
    anchorKind: null,
    sent: null,
  } as const;

  function navigateToChannel(botId: string): unknown {
    return {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                action: "navigate",
                target: {
                  environmentId: null,
                  botId,
                  threadId: null,
                  itemId: null,
                },
                span: { fromSegment: 0, toSegment: 0 },
                uncertain: false,
                question: null,
                control: null,
              }),
            },
          ],
        },
      ],
    };
  }

  async function startWithOtherBotOnAThread(): Promise<void> {
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    // bot-2 already shows a thread, as the person left it.
    act(() => useBotOpenThreadStore.getState().setRail("bot-2", THREAD_RAIL));
    await bringLive();
  }

  it("an older failing move to a bot's channel does not put that bot's thread rail back over a newer move to the same channel that landed", async () => {
    await startWithOtherBotOnAThread();
    fake.routeAnswer = () => navigateToChannel("bot-2");
    let rejectOlder: (error: Error) => void = () => undefined;
    const outcomes: Array<() => Promise<void>> = [
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOlder = reject;
        }),
      () => Promise.resolve(),
    ];
    fake.navigateOutcome = () =>
      (outcomes.shift() ?? (() => Promise.resolve()))();
    const generation = useVoiceSessionStore.getState().selectionGeneration;

    await say("Go to the release bot.", "d1");
    await say("Go to the release bot please.", "d2");
    // Precondition: the newer move landed on the channel.
    expect(useBotOpenThreadStore.getState().byBotId["bot-2"]).toBeUndefined();

    await act(async () => {
      rejectOlder(new Error("blocked"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await settle();

    expect(useBotOpenThreadStore.getState().byBotId["bot-2"]).toBeUndefined();
    expect(useVoiceSessionStore.getState().selectionGeneration).toBe(
      generation,
    );
  });
});

describe("an answer that lands before its post's request names it", () => {
  it("is held as an announcement, then read on the focused channel once the request resolves to it", async () => {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const commentary = fake.engines[0]?.appendCommentary;
    const answer = botRow("a-9", "The nightly build is green.");

    // A typed post's answer: nothing says yet which request it answers.
    act(() => {
      channel.setState({ snapshotLoaded: true, messages: [answer] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).not.toHaveBeenCalled();
    expect(
      useVoiceSessionStore.getState().queue.map((item) => [item.id, item.kind]),
    ).toEqual([["a-9", "announcement"]]);

    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [requestRow("u-1", "r-typed", "a-9"), answer],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining("The nightly build is green."),
      null,
    );
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).not.toContain("announcement");
    act(() =>
      eventsOf(0).onOutputTranscriptDelta("The nightly build is green"),
    );

    act(() => {
      channel.setState({
        snapshotLoaded: true,
        messages: [requestRow("u-1", "r-typed", "a-9"), answer],
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
  });
});

describe("a provisional answer on the focused channel", () => {
  const ANSWER_TEXT = "The nightly build is green.";

  /** Live on the channel, with `a-9` landed before any request names it: held as an announcement. */
  async function provisionalAnswer() {
    const channel = addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    addChat("t-other", { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await bringLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const answer = botRow("a-9", ANSWER_TEXT);
    act(() => channel.setState({ snapshotLoaded: true, messages: [answer] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).toEqual(["announcement"]);
    return { channel, answer };
  }

  function resolveRequest(
    channel: StoreApi<ChatState>,
    answer: ReplyRow,
  ): void {
    act(() =>
      channel.setState({
        snapshotLoaded: true,
        messages: [requestRow("u-1", "r-typed", "a-9"), answer],
      }),
    );
  }

  /** A notification names the row, so the queue holds the reply it is. */
  async function notificationNamesIt(): Promise<void> {
    act(() =>
      fake.attention.set({
        answers: [
          {
            messageId: "a-9",
            botId: BOT_ID,
            threadId: null,
            chatId: CHANNEL_ID,
            originHostId: "host-a",
            at: Date.now(),
            blocking: false,
          },
        ],
        prompts: { approvals: [], questions: [] },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).toEqual(["reply"]);
  }

  it("is still read once its request resolves after the person left the channel and came back", async () => {
    const { channel, answer } = await provisionalAnswer();
    const commentary = fake.engines[0]?.appendCommentary;

    focusOn({ ...CHANNEL_FOCUS, threadId: "t-other" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    focusOn(CHANNEL_FOCUS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(commentary).not.toHaveBeenCalled();

    resolveRequest(channel, answer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(commentary).toHaveBeenCalledTimes(1);
    expect(commentary).toHaveBeenCalledWith(
      expect.stringContaining(ANSWER_TEXT),
      null,
    );
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).not.toContain("announcement");
  });

  it("leaves a Read already with the engine to the queue: no second saying, its delegation kept, and its confirmation marks the channel read", async () => {
    const { channel, answer } = await provisionalAnswer();
    const commentary = fake.engines[0]?.appendCommentary;
    await notificationNamesIt();
    act(() => {
      runVoiceQueueVerb({
        kind: "read",
        itemId: "a-9",
        delegationId: "d-read",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(commentary.mock.calls).toEqual([
      [`CI bot said: ${ANSWER_TEXT}`, "d-read"],
    ]);

    resolveRequest(channel, answer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);

    act(() =>
      eventsOf(0).onOutputTranscriptDelta("The nightly build is green"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(commentary).toHaveBeenCalledTimes(1);
    expect(fake.markRead.mock.calls).toEqual([
      [{ epicId: BOT_ID, chatId: CHANNEL_ID }],
    ]);
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.state),
    ).toEqual(["heard"]);
  });

  it("never says a row the person set aside while its Read drained, once the request resolves", async () => {
    const { channel, answer } = await provisionalAnswer();
    const commentary = fake.engines[0]?.appendCommentary;
    await notificationNamesIt();
    act(() => {
      runVoiceQueueVerb({
        kind: "read",
        itemId: "a-9",
        delegationId: "d-read",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(commentary.mock.calls).toEqual([
      [`CI bot said: ${ANSWER_TEXT}`, "d-read"],
    ]);

    act(() => {
      runVoiceQueueVerb({ kind: "later", itemId: "a-9" });
    });
    resolveRequest(channel, answer);
    act(() =>
      eventsOf(0).onOutputTranscriptDelta("The nightly build is green"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(commentary).toHaveBeenCalledTimes(1);
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.state),
    ).toEqual(["dismissed"]);
    expect(fake.markRead).not.toHaveBeenCalled();
  });

  it("leaves a Read still waiting for the voice to the queue: it is said once, under its delegation", async () => {
    const { channel, answer } = await provisionalAnswer();
    const commentary = fake.engines[0]?.appendCommentary;
    await notificationNamesIt();
    act(() => eventsOf(0).onOutputTranscriptDelta("Working on it."));
    act(() => {
      runVoiceQueueVerb({
        kind: "read",
        itemId: "a-9",
        delegationId: "d-read",
      });
    });
    expect(commentary).not.toHaveBeenCalled();

    resolveRequest(channel, answer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(commentary.mock.calls).toEqual([
      [`CI bot said: ${ANSWER_TEXT}`, "d-read"],
    ]);

    act(() =>
      eventsOf(0).onOutputTranscriptDelta("The nightly build is green"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(commentary).toHaveBeenCalledTimes(1);
  });
});

describe("a bot whose stream ends for good under a live session", () => {
  it("takes its stopped answer out of the queue, and a read of it still waiting is never said", async () => {
    fake.activity.set(BOT_ID, {
      trunk: {
        state: "parked",
        startedAt: null,
        step: null,
        requestId: "req-7",
        reason: null,
      },
      threads: {},
    });
    addChat(CHANNEL_ID, { snapshotLoaded: true, messages: [] });
    selectBotTab(BOT_ID);
    focusOn(CHANNEL_FOCUS);
    await bringLive();
    expect(
      useVoiceSessionStore.getState().queue.map((item) => item.kind),
    ).toEqual(["failed"]);
    const commentary = fake.engines[0]?.appendCommentary;

    // The voice is busy, so the read waits its turn.
    act(() => eventsOf(0).onOutputTranscriptDelta("Working on it."));
    act(() => {
      runVoiceQueueVerb({
        kind: "read",
        itemId: "stopped:bot-1:req-7",
        delegationId: null,
      });
    });
    expect(commentary).not.toHaveBeenCalled();

    act(() => fake.activity.remove(BOT_ID));
    await settle();
    expect(useVoiceSessionStore.getState().queue).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(commentary).not.toHaveBeenCalled();
  });
});
