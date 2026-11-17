/**
 * A call's final words, through the REAL mutation path: the real
 * `CallController`, `useBotCallSendMutation`, `useHostMutation` and
 * `AuthService` (over a `MockRunnerHost`). The only boundary double is the
 * HostClient the host binding hands out, which records every
 * `bot.conversation.send` it is asked to dispatch.
 *
 * A mutation-cache `onMutate` holds the final-words send before its
 * `mutationFn` (TanStack awaits it first), so the authority can be retired in
 * the gap between the tail's own check and the dispatch.
 *
 * Copied from `call-controller-voice-authority.test.tsx`: the hook mocks that
 * give the controller its bot, host and chat, the fake engine, the
 * identity-route fetch, the sign-in and held-sign-out helpers and the
 * `dial` / `settle` / `speak` helpers.
 */
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { VoiceSessionMintFetchResult } from "@traycer-clients/shared/host-client/voice-sessions";
import { botConversationSendV13 } from "@traycer/protocol/host/bot/contracts";
import type {
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import { AuthService } from "@/lib/auth/auth-service";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
import { botMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";
import { CallController } from "../call-controller";

const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
const BOT_ID = "bot-1";
const HOST_ID = "host-a";
const CHANNEL_ID = "chan-1";
const CHANNEL_CALL: CallTarget = { botId: BOT_ID, threadId: null };

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
  boundHostId: HOST_ID,
  hostEpoch: 0,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "direct",
  appConversationChatId: CHANNEL_ID,
};

interface ConnectInput {
  readonly exchangeSdp: (offer: string) => Promise<string>;
  readonly events: VoiceEngineEvents;
}

interface FakeEngine {
  events: VoiceEngineEvents | null;
  readonly connect: Mock<(input: ConnectInput) => Promise<void>>;
  readonly close: Mock<() => Promise<void>>;
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
    engines: [] as FakeEngine[],
    // Set per test: the real service the controller's `useAuthService` reads.
    auth: { current: null as AuthService | null },
    shellLive: vi.fn<(live: boolean) => Promise<void>>(),
    // The text of every `bot.conversation.send` the HostClient double was
    // asked to dispatch, in order.
    dispatched: [] as string[],
    // Held before a call send's `mutationFn` when set.
    hold: { current: null as Promise<void> | null },
    // How many sends reached the cache-level `onMutate`.
    held: { count: 0 },
  };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ stub: "tab-host-client" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({
    requestMicrophoneAccess: () => Promise.resolve("granted"),
    onSystemSuspended: () => ({ dispose: () => undefined }),
    setVoiceSessionLive: fake.shellLive,
    setVoiceSessionIndicator: () => Promise.resolve(),
    onVoiceTrayAction: () => ({ dispose: () => undefined }),
  }),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => fake.auth.current,
  useHostClient: () => null,
  // The one HostClient double: the binding's requester for any named host.
  useHostBinding: () => ({
    auth: fake.auth.current,
    hostClient: {
      createRequesterForHostId: () => ({
        getRequestContextUserId: () =>
          useAuthStore.getState().contextMetadata?.userId ?? null,
        request: (method: string, params: { text: string }) => {
          if (method === "bot.conversation.send") {
            fake.dispatched.push(params.text);
          }
          return Promise.resolve(SEND_RESPONSE);
        },
        requestWithSignal: (method: string, params: { text: string }) => {
          if (method === "bot.conversation.send") {
            fake.dispatched.push(params.text);
          }
          return Promise.resolve(SEND_RESPONSE);
        },
        requestWithOptions: (method: string, params: { text: string }) => {
          if (method === "bot.conversation.send") {
            fake.dispatched.push(params.text);
          }
          return Promise.resolve(SEND_RESPONSE);
        },
        requestWithSignalRequiringHostMethodVersion: (
          method: string,
          params: { text: string },
        ) => {
          if (method === "bot.conversation.send") {
            fake.dispatched.push(params.text);
          }
          return Promise.resolve(SEND_RESPONSE);
        },
      }),
    },
  }),
}));
// Everything but the open: the sends under test are the real mutations.
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  useBotOpenMutation: () => ({
    mutateAsync: () =>
      Promise.resolve({
        bot: BOT,
        outcome: { kind: "serve-here", claimed: null },
      } satisfies BotOpenResponse),
  }),
}));

vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: (args: {
    readonly hostId: string;
    readonly enabled: boolean;
  }) => ({
    snapshot:
      args.enabled && args.hostId === HOST_ID ? { activity: null } : null,
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
  readHostMethodSchemaVersion: () => botConversationSendV13.schemaVersion,
}));
vi.mock("@/hooks/voice/use-voice-availability-query", () => ({
  useVoiceAvailabilityQuery: () => ({
    data: { available: true, voiceSelection: null },
  }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({ useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }) }),
);
vi.mock("@/lib/voice/audio-level", () => ({
  watchAudioLevel: () => ({ stop: () => undefined }),
}));
vi.mock("@/lib/voice/gpt-live-engine", () => ({
  createBrowserGptLiveEngine: () => {
    const engine: FakeEngine = {
      events: null,
      connect: vi.fn<(input: ConnectInput) => Promise<void>>(async (input) => {
        engine.events = input.events;
        await input.exchangeSdp("offer");
      }),
      close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    };
    fake.engines.push(engine);
    return engine;
  },
}));

function profileResponse(userId: string): Response {
  return new Response(
    JSON.stringify({
      user: {
        id: userId,
        name: `${userId} display`,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${userId}`,
        userID: userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${userId}`,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
}

/** The user each bearer belongs to, for the identity route. */
const USER_OF_TOKEN: Record<string, string> = {
  "user-1-token": "user-1",
};

function installFetch(): () => void {
  const original: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (
      input: unknown,
      init: { headers: Record<string, string> } | undefined,
    ) => {
      const bearer = (init?.headers.Authorization ?? "").replace("Bearer ", "");
      const userId: string | undefined = Object.entries(USER_OF_TOKEN).find(
        ([token]) => token === bearer,
      )?.[1];
      if (String(input) === VALIDATION_URL && userId !== undefined) {
        return Promise.resolve(profileResponse(userId));
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function okMint(id: string): VoiceSessionMintFetchResult {
  return {
    kind: "ok",
    session: {
      voiceSessionId: id,
      answerSdp: "answer",
      expiresAt: Date.now() + 7_200_000,
      acknowledgementLines: ["Okay.", "One moment.", "Got it."],
      voiceSelection: { kind: "absent" },
    },
  };
}

const SEND_RESPONSE = {
  messageId: "m1",
  requestId: "r1",
  delivery: "written",
  threadId: "t1",
};

let host: MockRunnerHost;
let service: AuthService;
let restoreFetch: () => void = () => undefined;
let queryClient: QueryClient;
// Everything a test holds open, released and drained in `afterEach` whether or
// not the test finished: the mutation and storage gates, and the sign-outs
// waiting on storage.
let heldGates: Deferred<void>[] = [];
let pendingSignOuts: Promise<boolean>[] = [];

function engine(): FakeEngine {
  const found = fake.engines.at(-1);
  if (found === undefined) throw new Error("no engine was created");
  return found;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settle(): Promise<void> {
  await advance(0);
}

function driverOf() {
  const driver = useVoiceSessionStore.getState().driver;
  if (driver === null) throw new Error("the controller mounted no driver");
  return driver;
}

async function dial(): Promise<void> {
  act(() => driverOf().start(CHANNEL_CALL));
  await settle();
}

async function endCall(): Promise<void> {
  act(() => driverOf().end());
  await settle();
}

/** The sign-in a window starts from: one stored session on `token`. */
async function signInAs(
  userId: string,
  token: string,
  refreshToken: string,
): Promise<void> {
  await host.tokenStore.signIn(
    { token, refreshToken },
    { id: userId, email: `${userId}@example.com`, name: `${userId} display` },
  );
  await service.start();
}

function speak(text: string): void {
  act(() => {
    engine().events?.onInputTranscriptDelta(text);
  });
}

/** `signOut` has bumped the identity generation and waits on storage. */
function startSignOutWaitingOnStorage(): Deferred<void> {
  const storage = deferred<void>();
  heldGates.push(storage);
  vi.spyOn(host.tokenStore, "delete").mockImplementation(() => storage.promise);
  pendingSignOuts.push(service.signOut());
  expect(useAuthStore.getState().status).toBe("signed-in");
  return storage;
}

/** A call send waits here, before its `mutationFn`, while `fake.hold` is set. */
function holdCallSends(): Deferred<void> {
  const gate = deferred<void>();
  heldGates.push(gate);
  fake.hold.current = gate.promise;
  return gate;
}

beforeEach(async () => {
  vi.useFakeTimers();
  fake.engines.length = 0;
  fake.dispatched.length = 0;
  fake.hold.current = null;
  fake.held.count = 0;
  heldGates = [];
  pendingSignOuts = [];
  fake.shellLive.mockReset();
  fake.shellLive.mockImplementation(() => Promise.resolve());
  fake.track.enabled = true;
  fake.track.stop.mockReset();
  useAuthStore.getState().setSignedOut();
  restoreFetch = installFetch();
  host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  service = new AuthService({ runnerHost: host });
  fake.auth.current = service;
  vi.spyOn(host, "mintVoiceSession").mockImplementation(() =>
    Promise.resolve(okMint("vs1")),
  );
  vi.spyOn(host, "getVoiceAvailability").mockImplementation(() =>
    Promise.resolve({ kind: "ok", available: true, voiceSelection: null }),
  );
  vi.spyOn(host, "endVoiceSession").mockImplementation(() =>
    Promise.resolve({ kind: "ok", closedAt: 1 }),
  );
  await signInAs("user-1", "user-1-token", "user-1-refresh");
  expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-1");
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
  // The cache-level `onMutate` is awaited before the mutation's own `onMutate`
  // and its `mutationFn` (query-core `Mutation.execute`).
  queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onMutate: (_variables, mutation) => {
        if (
          JSON.stringify(mutation.options.mutationKey) !==
          JSON.stringify(botMutationKeys.conversationSend())
        ) {
          return undefined;
        }
        fake.held.count += 1;
        return fake.hold.current;
      },
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CallController />
    </QueryClientProvider>,
  );
});

/** Resolves once no mutation is pending: terminal settlement, not a delay. */
function mutationsSettled(): Promise<void> {
  const cache = queryClient.getMutationCache();
  return new Promise<void>((resolve) => {
    const unsubscribe = cache.subscribe(() => {
      if (queryClient.isMutating() === 0) {
        unsubscribe();
        resolve();
      }
    });
    if (queryClient.isMutating() === 0) {
      unsubscribe();
      resolve();
    }
  });
}

afterEach(async () => {
  // Before any disposal: release every hold, then wait for what they held.
  fake.hold.current = null;
  await act(async () => {
    for (const gate of heldGates) gate.resolve();
    await Promise.allSettled(pendingSignOuts);
    await mutationsSettled();
  });
  expect(queryClient.isMutating()).toBe(0);
  cleanup();
  service.dispose();
  useAuthStore.getState().setSignedOut();
  restoreFetch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a call's final words", () => {
  it("are dispatched once per pending word under an intact authority", async () => {
    await dial();
    speak("Hold the build");

    await endCall();

    expect(fake.dispatched).toEqual(["Hold the build"]);
  });

  it("are not dispatched when the authority is retired after the tail's own check and before its send runs", async () => {
    await dial();
    speak("Hold the build");
    const gate = holdCallSends();

    await endCall();
    expect(fake.held.count).toBe(1);
    expect(fake.dispatched).toEqual([]);
    const before = useVoiceSessionStore.getState();
    startSignOutWaitingOnStorage();
    gate.resolve();
    await settle();

    expect(fake.dispatched).toEqual([]);
    const after = useVoiceSessionStore.getState();
    expect(after.endReason).toBe(before.endReason);
    expect(after.refusal).toBe(before.refusal);
  });
});
