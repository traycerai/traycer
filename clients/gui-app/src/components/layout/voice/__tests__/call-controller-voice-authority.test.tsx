/**
 * One authority per call: the REAL `CallController` over the REAL
 * `AuthService` (built on a `MockRunnerHost`), with the runner host's
 * `mintVoiceSession` / `endVoiceSession` spied for the bearer each request
 * leaves under. Nothing about the auth layer is faked, so a request that
 * would go out under another principal's bearer shows up here.
 *
 * Harness copied from `call-controller.test.tsx`: the hook mocks that give the
 * controller its bot, host and chat (`vi.mock` list), the fake engine, and the
 * `dial` / `settle` helpers. Copied from `auth-service.test.ts`: the
 * identity-route response and the `ExternalSession` fixture.
 */
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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  VoiceAvailabilityFetchResult,
  VoiceSessionEndFetchResult,
  VoiceSessionMintFetchResult,
  VoiceSessionMintRequest,
} from "@traycer-clients/shared/host-client/voice-sessions";
import { botConversationSendV13 } from "@traycer/protocol/host/bot/contracts";
import type {
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import { AuthService, type ExternalSession } from "@/lib/auth/auth-service";
import type { VoiceEngineEvents } from "@/lib/voice/engine";
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

interface Exchange {
  readonly answered: string | null;
  readonly rejected: boolean;
}

interface FakeEngine {
  events: VoiceEngineEvents | null;
  /** How each `exchangeSdp` the controller handed the engine settled. */
  readonly exchanges: Exchange[];
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
    // When set, an engine's `connect` waits on it after the answer is taken.
    connectGate: { current: null as Promise<void> | null },
    shellLive: vi.fn<(live: boolean) => Promise<void>>(),
    // The text of every call send that left, in order.
    sentTexts: [] as string[],
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
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotConversationSendMutation: () => ({
    mutateAsync: () =>
      Promise.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: "t1",
      } satisfies BotConversationSendResponse),
  }),
  useBotCallSendMutation: () => ({
    mutateAsync: (variables: {
      readonly request: { readonly text: string };
    }) => {
      fake.sentTexts.push(variables.request.text);
      return Promise.resolve({
        messageId: "m1",
        requestId: "r1",
        delivery: "written",
        threadId: "t1",
      } satisfies BotConversationSendResponse);
    },
  }),
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
      exchanges: [],
      connect: vi.fn<(input: ConnectInput) => Promise<void>>(async (input) => {
        engine.events = input.events;
        await input.exchangeSdp("offer").then(
          async (answered) => {
            engine.exchanges.push({ answered, rejected: false });
            await fake.connectGate.current;
          },
          (error: unknown) => {
            engine.exchanges.push({ answered: null, rejected: true });
            throw error;
          },
        );
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

/** A session projected into this window by a sibling, for `userId` on `token`. */
function externalSessionForUser(
  userId: string,
  token: string,
): ExternalSession {
  const now = new Date("2026-07-30T10:00:00.000Z");
  return {
    status: "signed-in",
    token,
    profile: {
      userId,
      userName: `${userId} display`,
      email: `${userId}@example.com`,
      avatarUrl: null,
    },
    user: {
      user: {
        id: userId,
        name: `${userId} display`,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: now,
        updatedAt: now,
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
        createdAt: now,
        updatedAt: now,
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
      environments: { personal: null, teams: [] },
      actingAs: null,
    },
  };
}

/** The user each bearer belongs to, for the identity route. */
const USER_OF_TOKEN: Record<string, string> = {
  "user-1-token": "user-1",
  "user-1-rotated": "user-1",
  "user-1-again": "user-1",
  "user-2-token": "user-2",
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

let host: MockRunnerHost;
let service: AuthService;
let restoreFetch: () => void = () => undefined;
let mint: Mock<
  (
    bearer: string,
    request: VoiceSessionMintRequest,
  ) => Promise<VoiceSessionMintFetchResult>
>;
let availability: Mock<
  (bearerToken: string) => Promise<VoiceAvailabilityFetchResult>
>;
let end: Mock<
  (bearer: string, id: string) => Promise<VoiceSessionEndFetchResult>
>;

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

/** Another account takes the window over: the store's user changes. */
async function switchTo(userId: string, token: string): Promise<void> {
  act(() =>
    service.applyExternalSession(externalSessionForUser(userId, token)),
  );
  await settle();
  expect(useAuthStore.getState().contextMetadata?.userId).toBe(userId);
}

/** The same person signs out and in again: new credentials, same user. */
async function signOutAndBackIn(token: string): Promise<void> {
  await act(async () => {
    await service.signOut();
  });
  await act(async () => {
    await signInAs("user-1", token, `${token}-refresh`);
  });
  await settle();
  expect(useAuthStore.getState().status).toBe("signed-in");
}

/** Every phase the call store passes through, in order. */
function recordPhases(): ReadonlyArray<string> {
  const phases: string[] = [useVoiceSessionStore.getState().phase];
  useVoiceSessionStore.subscribe((state) => {
    if (phases.at(-1) !== state.phase) phases.push(state.phase);
  });
  return phases;
}

/** The person says `text`; no utterance boundary closes it yet. */
function speak(text: string): void {
  act(() => {
    engine().events?.onInputTranscriptDelta(text);
  });
}

/** `signOut` has bumped the identity generation and waits on storage. */
function startSignOutWaitingOnStorage(): Deferred<void> {
  const storage = deferred<void>();
  vi.spyOn(host.tokenStore, "delete").mockImplementation(() => storage.promise);
  void service.signOut();
  expect(useAuthStore.getState().status).toBe("signed-in");
  return storage;
}

/** The ways a call's principal changes with the session still `signed-in`. */
const REVOCATIONS: ReadonlyArray<{
  readonly name: string;
  readonly revoke: () => Promise<void>;
}> = [
  {
    name: "sign-out waits on its storage",
    revoke: async () => {
      startSignOutWaitingOnStorage();
      await settle();
    },
  },
  {
    name: "the same user's credentials are replaced",
    revoke: () => signOutAndBackIn("user-1-again"),
  },
  {
    name: "the auth service is disposed",
    revoke: async () => {
      service.dispose();
      await settle();
    },
  },
];

function mintBearers(): ReadonlyArray<string> {
  return mint.mock.calls.map(([bearer]) => bearer);
}

function endCalls(): ReadonlyArray<readonly [string, string]> {
  return end.mock.calls;
}

beforeEach(async () => {
  vi.useFakeTimers();
  fake.engines.length = 0;
  fake.connectGate.current = null;
  fake.sentTexts.length = 0;
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
  mint = vi
    .spyOn(host, "mintVoiceSession")
    .mockImplementation(() => Promise.resolve(okMint("vs1")));
  availability = vi
    .spyOn(host, "getVoiceAvailability")
    .mockImplementation(() =>
      Promise.resolve({ kind: "ok", available: true, voiceSelection: null }),
    );
  end = vi
    .spyOn(host, "endVoiceSession")
    .mockImplementation(() => Promise.resolve({ kind: "ok", closedAt: 1 }));
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
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CallController />
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  service.dispose();
  useAuthStore.getState().setSignedOut();
  restoreFetch();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a call's one authority", () => {
  it("dispatches the call's mint under the signed-in principal's bearer", async () => {
    await dial();

    expect(useVoiceSessionStore.getState().phase).toBe("live");
    expect(mintBearers()).toEqual(["user-1-token"]);
  });

  it("does not answer a mint that lands after another account took the window, and ends nothing under that account", async () => {
    const held = deferred<VoiceSessionMintFetchResult>();
    mint.mockImplementationOnce(() => held.promise);
    await dial();
    expect(mintBearers()).toEqual(["user-1-token"]);

    await switchTo("user-2", "user-2-token");
    held.resolve(okMint("vs-late"));
    await settle();

    expect(
      end.mock.calls.filter(([bearer]) => bearer === "user-2-token"),
    ).toEqual([]);
    // The seam answers a changed principal without a request at all.
    expect(endCalls()).toEqual([]);
    expect(engine().close).toHaveBeenCalled();
    expect(engine().exchanges).toEqual([{ answered: null, rejected: true }]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("ends a mint that lands after the person ended the call, under the call's own bearer, once", async () => {
    const held = deferred<VoiceSessionMintFetchResult>();
    mint.mockImplementationOnce(() => held.promise);
    await dial();

    await endCall();
    held.resolve(okMint("vs-late"));
    await settle();

    expect(endCalls()).toEqual([["user-1-token", "vs-late"]]);
    expect(engine().exchanges).toEqual([{ answered: null, rejected: true }]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("ends under the rotated bearer when the same user's bearer rotated during the call", async () => {
    await dial();
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    await switchTo("user-1", "user-1-rotated");
    await endCall();

    expect(endCalls()).toEqual([["user-1-rotated", "vs1"]]);
  });

  it("sends no end request when the same user signed out and back in on new credentials", async () => {
    await dial();
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    await signOutAndBackIn("user-1-again");
    await endCall();

    expect(endCalls()).toEqual([]);
  });

  it("sends no end request once the auth service is disposed", async () => {
    await dial();
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    service.dispose();
    await endCall();

    expect(endCalls()).toEqual([]);
  });

  it("sends a renewal's mint under the principal the call began with", async () => {
    await dial();
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    act(() => {
      engine().events?.onClosed("connection");
    });
    await settle();

    expect(fake.engines).toHaveLength(2);
    expect(mintBearers()).toEqual(["user-1-token", "user-1-token"]);
  });

  it("sends no renewal mint under credentials the call did not begin with", async () => {
    await dial();
    expect(useVoiceSessionStore.getState().phase).toBe("live");

    await signOutAndBackIn("user-1-again");
    act(() => {
      engine().events?.onClosed("connection");
    });
    await settle();

    expect(mintBearers()).toEqual(["user-1-token"]);
  });

  describe.each(REVOCATIONS)(
    "when $name between the mint going out and its answer",
    ({ revoke }) => {
      it("refuses the answer, keeps the id for cleanup unsent, and mints no second session", async () => {
        const held = deferred<VoiceSessionMintFetchResult>();
        mint.mockImplementationOnce(() => held.promise);
        const phases = recordPhases();
        const cleanup = vi.spyOn(service, "endVoiceSession");
        await dial();

        await revoke();
        held.resolve(okMint("vs-late-signout"));
        await settle();

        expect(engine().exchanges).toEqual([
          { answered: null, rejected: true },
        ]);
        expect(phases).not.toContain("live");
        expect(fake.shellLive).not.toHaveBeenCalledWith(true);
        expect(cleanup.mock.calls.map(([id]) => id)).toEqual([
          "vs-late-signout",
        ]);
        expect(engine().close).toHaveBeenCalled();
        expect(endCalls()).toEqual([]);
        expect(mint).toHaveBeenCalledTimes(1);
        expect(useVoiceSessionStore.getState().refusal).toBe("session-changed");
      });
    },
  );

  it("sends nothing more once the sign-out's storage wait ends", async () => {
    const held = deferred<VoiceSessionMintFetchResult>();
    mint.mockImplementationOnce(() => held.promise);
    await dial();
    const storage = startSignOutWaitingOnStorage();
    held.resolve(okMint("vs-late-signout"));
    await settle();

    storage.resolve();
    await settle();

    expect(endCalls()).toEqual([]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  describe.each(REVOCATIONS)(
    "when $name after the answer and before the engine connects",
    ({ revoke }) => {
      it("never goes live, closes the engine, ends nothing and asks for no second session", async () => {
        const gate = deferred<void>();
        fake.connectGate.current = gate.promise;
        const phases = recordPhases();
        const cleanup = vi.spyOn(service, "endVoiceSession");
        await dial();
        expect(engine().exchanges).toEqual([
          { answered: "answer", rejected: false },
        ]);

        await revoke();
        gate.resolve();
        await settle();

        expect(phases).not.toContain("live");
        expect(fake.shellLive).not.toHaveBeenCalledWith(true);
        expect(engine().close).toHaveBeenCalled();
        expect(cleanup.mock.calls.map(([id]) => id)).toEqual(["vs1"]);
        expect(endCalls()).toEqual([]);
        expect(mint).toHaveBeenCalledTimes(1);
        expect(useVoiceSessionStore.getState().refusal).toBe("session-changed");
      });
    },
  );

  describe("the call's capability", () => {
    it("is read once per new call under the call's bearer, and not again by a renewal", async () => {
      await dial();
      expect(useVoiceSessionStore.getState().phase).toBe("live");
      expect(availability.mock.calls).toEqual([["user-1-token"]]);

      act(() => {
        engine().events?.onClosed("connection");
      });
      await settle();
      expect(mintBearers()).toEqual(["user-1-token", "user-1-token"]);
      expect(availability).toHaveBeenCalledTimes(1);

      await endCall();
      await dial();
      expect(availability.mock.calls).toEqual([
        ["user-1-token"],
        ["user-1-token"],
      ]);
    });

    it("dispatches no mint when the principal changes while the read is out, and refuses the call as session-changed", async () => {
      const held = deferred<VoiceAvailabilityFetchResult>();
      availability.mockImplementationOnce(() => held.promise);
      await dial();

      await signOutAndBackIn("user-1-again");
      held.resolve({ kind: "ok", available: true, voiceSelection: null });
      await settle();

      expect(mint).not.toHaveBeenCalled();
      expect(useVoiceSessionStore.getState().phase).toBe("idle");
      expect(useVoiceSessionStore.getState().refusal).toBe("session-changed");
    });
  });

  describe("the words a call leaves unsent", () => {
    it("are sent by an ordinary End under an intact authority", async () => {
      await dial();
      speak("Hold the build");

      await endCall();

      expect(fake.sentTexts).toEqual(["Hold the build"]);
    });

    describe.each(REVOCATIONS.filter(({ name }) => !name.includes("disposed")))(
      "when $name while the call is live",
      ({ revoke }) => {
        it("ends a refused renewal as session-changed and sends none of them", async () => {
          await dial();
          expect(useVoiceSessionStore.getState().phase).toBe("live");
          speak("Hold the build");
          await revoke();
          expect(useVoiceSessionStore.getState().phase).toBe("live");

          act(() => {
            engine().events?.onClosed("connection");
          });
          await settle();

          const state = useVoiceSessionStore.getState();
          expect(state.phase).toBe("idle");
          expect(state.endReason).toBe("session-changed");
          expect(fake.sentTexts).toEqual([]);
          expect(mint).toHaveBeenCalledTimes(1);
        });
      },
    );
  });
});
