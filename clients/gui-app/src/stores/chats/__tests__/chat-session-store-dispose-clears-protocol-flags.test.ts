import { describe, expect, it } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * The three per-stream capability flags must all read `false` on a DISPOSED
 * store.
 *
 * Each is computed in one place - `onConnectionStatus` - and each is true only
 * while `status === "open"`. `dispose()` calls `closeStreamClient()`, which
 * retires the stream guard BEFORE `client.close()`, so that callback never
 * runs on this path and nothing recomputes them. A store held past disposal
 * therefore keeps advertising capabilities of a stream it no longer has, and
 * `chat-tile` reads these to decide whether Cmd+Enter steers, whether a send
 * may go hash-only, and whether an interview delivery can be retried.
 *
 * `retry()` already clears all three together; this pins that `dispose()`
 * agrees with it. Written after only `draftBlobBridgeSupported` was cleared
 * here - the epic that added it cleared its own flag explicitly and left the
 * two older ones, which is why this asserts the SET rather than one member.
 */

const EPIC_ID = "epic-dispose-flags";
const CHAT_ID = "chat-dispose-flags";
const OWNER_ID = "owner-dispose-flags";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

/** Every capability answers TRUE, so a surviving `true` can only be staleness. */
function createHarness(): Harness {
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
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        interviewSettlementActionsProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
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

describe("chat session store - dispose clears every per-stream capability flag", () => {
  it("leaves no capability reading true after dispose", () => {
    const harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null, null);

    // Precondition: without this the assertion below could pass on a store
    // that never advertised anything, which would test nothing.
    expect({
      steer: harness.handle.store.getState().steerProtocolSupported,
      bridge: harness.handle.store.getState().draftBlobBridgeSupported,
      interview:
        harness.handle.store.getState().interviewDeliveryRetryProtocolSupported,
    }).toEqual({ steer: true, bridge: true, interview: true });

    harness.handle.dispose();

    expect({
      steer: harness.handle.store.getState().steerProtocolSupported,
      bridge: harness.handle.store.getState().draftBlobBridgeSupported,
      interview:
        harness.handle.store.getState().interviewDeliveryRetryProtocolSupported,
    }).toEqual({ steer: false, bridge: false, interview: false });
  });

  it("agrees with retry(), which clears the same three", () => {
    // Two paths tear the stream down and both must answer the same way. If
    // they ever diverge again, whichever one is wrong is the one that did not
    // move with the other.
    const harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null, null);
    harness.handle.store.getState().retry();

    const afterRetry = {
      steer: harness.handle.store.getState().steerProtocolSupported,
      bridge: harness.handle.store.getState().draftBlobBridgeSupported,
      interview:
        harness.handle.store.getState().interviewDeliveryRetryProtocolSupported,
    };

    harness.callbacks().onConnectionStatus("open", null, null);
    harness.handle.dispose();

    expect({
      steer: harness.handle.store.getState().steerProtocolSupported,
      bridge: harness.handle.store.getState().draftBlobBridgeSupported,
      interview:
        harness.handle.store.getState().interviewDeliveryRetryProtocolSupported,
    }).toEqual(afterRetry);
  });
});
