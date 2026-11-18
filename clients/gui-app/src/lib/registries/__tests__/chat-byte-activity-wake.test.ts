import { afterEach, expect, it } from "vitest";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import {
  DESKTOP_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";
import { getProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";

const EPIC = "epic-byte-activity-wake";
const CHAT = "chat-byte-activity-wake";
const HOST = "host-byte-activity-wake";

afterEach(() => {
  disposeAllChatSessions();
  __resetAgentActivityStoreForTests();
  setRetentionProfile(DESKTOP_RETENTION_PROFILE);
});

it("evicts an over-budget warm chat when only the activity frame makes it eligible", async () => {
  setRetentionProfile({
    ...DESKTOP_RETENTION_PROFILE,
    maxManagedDataBytes: 1,
  });
  __setHostAgentActivityHealthForTests(HOST, {
    connectionStatus: "open",
    servedBy: "local",
    stateFrameSeenThisEpoch: true,
  });
  __setHostAgentActivityStateForTests(
    HOST,
    { [EPIC]: { working: [CHAT], turn: [CHAT] } },
    "local",
    null,
  );

  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST,
    epicId: EPIC,
    chatId: CHAT,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
  handle.store.setState({
    access: { role: "owner", ownerUserId: "owner", canAct: true },
  });
  const registry = __getChatSessionRegistryForTests();
  registry.acquire(
    { epicId: EPIC, chatId: CHAT, hostId: HOST, scopeKey: "byte-wake" },
    () => handle,
  );
  registry.release(EPIC, CHAT, HOST);
  await Promise.resolve();

  expect(
    getProcessMemoryRuntime().accountant.snapshot().totalChargedBytes,
  ).toBeGreaterThan(1);
  expect(registry.peek(EPIC, CHAT, HOST)).toBe(handle);

  // No chat-store write or live epic session follows this frame. The byte
  // controller must still be told that the chat's cap hold just lifted.
  __setHostAgentActivityStateForTests(HOST, {}, "local", null);
  await Promise.resolve();
  await Promise.resolve();
  expect(registry.peek(EPIC, CHAT, HOST)).toBeNull();
});
