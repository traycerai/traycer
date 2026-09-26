import { afterEach, describe, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS } from "@traycer-clients/shared/host-transport/remote/index";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { subscribeWarmChatSleepOnResume } from "@/lib/chats/chat-session-resume-sleep";
import { setMobileApp } from "@/lib/mobile-app";

const EPIC_ID = "epic-resume-sleep";
const HOST_ID = "host-resume-sleep";
const LONG_BACKGROUND_MS = WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS;

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly opens: () => number;
  readonly closes: () => number;
}

function createHarness(chatId: string): Harness {
  let opens = 0;
  let closes = 0;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId,
    userId: "user-resume-sleep",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => {
      opens += 1;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => false,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => {
          closes += 1;
        },
      };
    },
  });
  return { handle, opens: () => opens, closes: () => closes };
}

/** A chat in the registry; `leased: false` releases it to the warm pool. */
function openChat(chatId: string, leased: boolean): Harness {
  const harness = createHarness(chatId);
  const registry = __getChatSessionRegistryForTests();
  registry.acquire(
    { epicId: EPIC_ID, chatId, hostId: HOST_ID, scopeKey: "resume-scope" },
    () => harness.handle,
  );
  if (!leased) registry.release(EPIC_ID, chatId, HOST_ID);
  return harness;
}

function makeRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

afterEach(() => {
  disposeAllChatSessions();
  setMobileApp(false);
});

describe("subscribeWarmChatSleepOnResume", () => {
  it("after a long background, leaves lease-free idle chats asleep and the leased one connected", () => {
    setMobileApp(true);
    const runnerHost = makeRunnerHost();
    const warm = openChat("chat-warm", false);
    const onScreen = openChat("chat-on-screen", true);
    const dispose = subscribeWarmChatSleepOnResume(runnerHost);

    runnerHost.emitSystemResumed({ backgroundedForMs: LONG_BACKGROUND_MS });

    expect(warm.handle.store.getState().asleep).toBe(true);
    expect(warm.closes()).toBe(1);
    expect(onScreen.handle.store.getState().asleep).toBe(false);
    expect(onScreen.closes()).toBe(0);
    dispose();
  });

  it("keeps a lease-free chat with work in flight connected", () => {
    setMobileApp(true);
    const runnerHost = makeRunnerHost();
    const busy = openChat("chat-busy", true);
    busy.handle.store.setState({ runStatus: "running" });
    __getChatSessionRegistryForTests().release(EPIC_ID, "chat-busy", HOST_ID);
    const dispose = subscribeWarmChatSleepOnResume(runnerHost);

    runnerHost.emitSystemResumed({ backgroundedForMs: LONG_BACKGROUND_MS });

    expect(busy.handle.store.getState().asleep).toBe(false);
    expect(busy.closes()).toBe(0);
    dispose();
  });

  it("reconnects a chat left asleep once a tile leases it", () => {
    setMobileApp(true);
    const runnerHost = makeRunnerHost();
    const warm = openChat("chat-warm", false);
    const dispose = subscribeWarmChatSleepOnResume(runnerHost);
    runnerHost.emitSystemResumed({ backgroundedForMs: LONG_BACKGROUND_MS });
    expect(warm.opens()).toBe(1);

    __getChatSessionRegistryForTests().acquire(
      {
        epicId: EPIC_ID,
        chatId: "chat-warm",
        hostId: HOST_ID,
        scopeKey: "resume-scope",
      },
      () => createHarness("chat-warm").handle,
    );

    expect(warm.opens()).toBe(2);
    expect(warm.handle.store.getState().asleep).toBe(false);
    dispose();
  });

  it("leaves warm chats alone after a quick app switch, whose sockets may have survived", () => {
    setMobileApp(true);
    const runnerHost = makeRunnerHost();
    const warm = openChat("chat-warm", false);
    const dispose = subscribeWarmChatSleepOnResume(runnerHost);

    runnerHost.emitSystemResumed({
      backgroundedForMs: WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS - 1,
    });
    runnerHost.emitSystemResumed({ backgroundedForMs: null });

    expect(warm.handle.store.getState().asleep).toBe(false);
    expect(warm.closes()).toBe(0);
    dispose();
  });

  it("does nothing off the mobile app", () => {
    const runnerHost = makeRunnerHost();
    const warm = openChat("chat-warm", false);
    const dispose = subscribeWarmChatSleepOnResume(runnerHost);

    runnerHost.emitSystemResumed({ backgroundedForMs: LONG_BACKGROUND_MS });

    expect(warm.handle.store.getState().asleep).toBe(false);
    expect(warm.closes()).toBe(0);
    dispose();
  });

  it("stops listening once disposed", () => {
    setMobileApp(true);
    const runnerHost = makeRunnerHost();
    const warm = openChat("chat-warm", false);
    const dispose = subscribeWarmChatSleepOnResume(runnerHost);
    dispose();

    runnerHost.emitSystemResumed({ backgroundedForMs: LONG_BACKGROUND_MS });

    expect(warm.handle.store.getState().asleep).toBe(false);
  });
});
