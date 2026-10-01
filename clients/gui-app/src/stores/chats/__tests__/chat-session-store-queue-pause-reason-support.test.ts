import { describe, expect, it } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * `ChatSessionState.queuePauseReasonProtocolSupported` mirrors whether THIS
 * session's stream client can say a queue pause carries a reason - read once,
 * at `onConnectionStatus("open")`, from the stream client's own probe.
 */

const EPIC_ID = "epic-queue-pause-reason";
const CHAT_ID = "chat-queue-pause-reason";
const OWNER_ID = "owner-queue-pause-reason";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

/**
 * `probe` is omitted entirely (not just `undefined`) when it is `null`, so
 * the double matches a stream client build that predates the method - the
 * absence the store must read as "cannot say" rather than as a `false`
 * answer.
 */
function createHarness(probe: boolean | null): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      const base = {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
      if (probe === null) {
        return base;
      }
      return {
        ...base,
        queuePauseReasonProtocolSupported: () => probe,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

interface LiveProbeHarness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
  setProbe(next: boolean): void;
  factoryCallCount(): number;
}

/**
 * Like {@link createHarness}, but the double's `queuePauseReasonProtocolSupported`
 * closes over a mutable answer instead of a fixed one, so a test can change
 * what the SAME session's next open reports without rebuilding the store -
 * the shape a host upgrade carried by a plain transport reconnect takes
 * here (the same `ChatStreamClient` re-handshakes and re-answers the probe;
 * no new client is built). `factoryCallCount` pins that the session stays
 * on that one client: `streamClientFactory` runs exactly once across a
 * cell that goes open -> reconnecting -> open again, so a future edit that
 * sneaks a `retry()` (which builds a NEW client) back in turns the cell red.
 */
function createLiveProbeHarness(initialProbe: boolean): LiveProbeHarness {
  let callbacks: ChatStreamCallbacks | null = null;
  let currentProbe = initialProbe;
  let calls = 0;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      calls += 1;
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => false,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
        queuePauseReasonProtocolSupported: () => currentProbe,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
    setProbe: (next) => {
      currentProbe = next;
    },
    factoryCallCount: () => calls,
  };
}

function flag(state: ChatSessionState): boolean | null {
  return state.queuePauseReasonProtocolSupported;
}

describe("chat-session-store queuePauseReasonProtocolSupported", () => {
  it("is null before the connection opens", () => {
    const harness = createHarness(true);
    try {
      expect(flag(harness.handle.store.getState())).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });

  it("takes the probe's false answer at open", () => {
    const harness = createHarness(false);
    try {
      harness.callbacks().onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(false);
    } finally {
      harness.handle.dispose();
    }
  });

  it("takes the probe's true answer at open", () => {
    const harness = createHarness(true);
    try {
      harness.callbacks().onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(true);
    } finally {
      harness.handle.dispose();
    }
  });

  it("stays null at open when the stream client has no probe at all", () => {
    const harness = createHarness(null);
    try {
      harness.callbacks().onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });

  it("keeps the value unchanged through a transition to reconnecting", () => {
    const harness = createHarness(false);
    try {
      harness.callbacks().onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(false);

      harness.callbacks().onConnectionStatus("reconnecting", null, null);
      expect(flag(harness.handle.store.getState())).toBe(false);
    } finally {
      harness.handle.dispose();
    }
  });

  it("resets to null on retry()", () => {
    const harness = createHarness(true);
    try {
      harness.callbacks().onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(true);

      harness.handle.store.getState().retry();
      expect(flag(harness.handle.store.getState())).toBe(null);
    } finally {
      harness.handle.dispose();
    }
  });

  it("re-reads the probe when the same session re-opens after a reconnect (false → true)", () => {
    const harness = createLiveProbeHarness(false);
    try {
      const callbacks = harness.callbacks();
      callbacks.onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(false);

      callbacks.onConnectionStatus("reconnecting", null, null);
      expect(flag(harness.handle.store.getState())).toBe(false);

      harness.setProbe(true);
      callbacks.onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(true);

      expect(harness.factoryCallCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });

  it("re-reads the probe when the same session re-opens after a reconnect (true → false)", () => {
    const harness = createLiveProbeHarness(true);
    try {
      const callbacks = harness.callbacks();
      callbacks.onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(true);

      callbacks.onConnectionStatus("reconnecting", null, null);
      expect(flag(harness.handle.store.getState())).toBe(true);

      harness.setProbe(false);
      callbacks.onConnectionStatus("open", null, null);
      expect(flag(harness.handle.store.getState())).toBe(false);

      expect(harness.factoryCallCount()).toBe(1);
    } finally {
      harness.handle.dispose();
    }
  });
});
