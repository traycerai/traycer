import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { useChatStreamSyncState } from "@/hooks/chats/use-chat-stream-sync-state";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-A";

interface SeededSession {
  readonly handle: ChatSessionStoreHandle;
  readonly callbacks: () => ChatStreamCallbacks;
}

/**
 * A REAL chat session, in the REAL process-wide registry.
 *
 * The alternative - an empty registry in every case - is satisfied by a hook
 * that always answers `closed`, and by one whose store subscription is a no-op.
 * Both are the failure this hook exists to avoid, so the tests have to be able
 * to see a session and watch its status move inside one.
 */
function seedSession(chatId: string): SeededSession {
  let captured: ChatStreamCallbacks | null = null;
  const handle = __getChatSessionRegistryForTests().acquire(
    { epicId: EPIC_ID, chatId, hostId: HOST_ID, scopeKey: "scope-1" },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
          captured = nextCallbacks;
          return {
            sendAction: () => undefined,
            sameTurnSteeringProtocolSupported: () => true,
            requestTranscriptRange: () => undefined,
            requestResnapshot: () => undefined,
            close: () => undefined,
          };
        },
      }),
  );
  return {
    handle,
    callbacks: () => {
      if (captured === null) throw new Error("stream factory was not invoked");
      return captured;
    },
  };
}

afterEach(() => {
  cleanup();
  __getChatSessionRegistryForTests().disposeAll();
});

describe("useChatStreamSyncState", () => {
  it("reports a closed stream when no session is open for the pair", () => {
    // `closed` rather than `connecting` is the load-bearing part: a tile with
    // no chat session is not coming back, and reporting otherwise would put a
    // syncing strip on a surface that has no stream at all.
    const { result } = renderHook(() =>
      useChatStreamSyncState(EPIC_ID, CHAT_ID, HOST_ID),
    );
    expect(result.current.status).toBe("closed");
    expect(result.current.hasContent).toBe(false);
  });

  it("reports a closed stream for a surface that names no host", () => {
    // A chat id alone does not identify a session - it is host-minted - so a
    // caller with no host must resolve nothing rather than fall back to
    // whichever host happens to be active.
    seedSession(CHAT_ID);
    const { result } = renderHook(() =>
      useChatStreamSyncState(EPIC_ID, CHAT_ID, null),
    );
    expect(result.current.status).toBe("closed");
  });

  it("reports a closed stream for a session on a DIFFERENT host", () => {
    seedSession(CHAT_ID);
    const { result } = renderHook(() =>
      useChatStreamSyncState(EPIC_ID, CHAT_ID, "host-B"),
    );
    expect(result.current.status).toBe("closed");
  });

  it("reads an open session's live status", () => {
    const session = seedSession(CHAT_ID);
    const { result } = renderHook(() =>
      useChatStreamSyncState(EPIC_ID, CHAT_ID, HOST_ID),
    );
    act(() => {
      session.callbacks().onConnectionStatus("open", null);
    });
    expect(result.current.status).toBe("open");
  });

  it("re-renders when the status moves INSIDE an already-open session", () => {
    // The half a registry subscription cannot see. The registry notifies on
    // membership only - a session appearing or going away - so a hook that
    // subscribed to it alone would sit on whatever status it first read, and
    // the strip would never appear when the socket dropped.
    const session = seedSession(CHAT_ID);
    const { result } = renderHook(() =>
      useChatStreamSyncState(EPIC_ID, CHAT_ID, HOST_ID),
    );
    act(() => {
      session.callbacks().onConnectionStatus("open", null);
    });
    expect(result.current.status).toBe("open");

    act(() => {
      session.callbacks().onConnectionStatus("reconnecting", null);
    });
    expect(result.current.status).toBe("reconnecting");
  });

  it("picks up a session that appears after the first render", () => {
    // The other half: membership. A tile can render before its chat session
    // has been acquired, and the hook has to notice the arrival rather than
    // stay on its no-session answer.
    const { result } = renderHook(() =>
      useChatStreamSyncState(EPIC_ID, CHAT_ID, HOST_ID),
    );
    expect(result.current.status).toBe("closed");

    let session: SeededSession | null = null;
    act(() => {
      session = seedSession(CHAT_ID);
    });
    act(() => {
      session?.callbacks().onConnectionStatus("reconnecting", null);
    });
    expect(result.current.status).toBe("reconnecting");
  });
});
