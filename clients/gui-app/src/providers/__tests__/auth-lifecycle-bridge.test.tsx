import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

function chatScope(userId: string): string {
  return `test-chat-scope:${userId}`;
}

function fakeOpenEpicHandle(id: string): OpenEpicStoreHandle & {
  disposeCount: number;
} {
  const h = {
    epicId: id,
    userId: null,
    doc: {} as never,
    awareness: {} as never,
    store: {
      getState: () => ({ unsyncedQueueSize: 0, snapshotMeta: null }) as never,
      subscribe: () => () => undefined,
    } as never,
    dispose: () => {
      h.disposeCount += 1;
    },
    requestFreshSnapshot: () => undefined,
    isClean: () => true,
    disposeCount: 0,
  };
  return h;
}

function fakeChatHandle(
  epicId: string,
  chatId: string,
  userId: string | null,
): {
  readonly handle: ChatSessionStoreHandle;
  readonly closeCount: () => number;
} {
  const calls = { close: 0 };
  return {
    handle: createChatSessionStore({
      epicId,
      chatId,
      userId,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        close: () => {
          calls.close += 1;
        },
      }),
    }),
    closeCount: () => calls.close,
  };
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

describe("<EpicSessionLifecycleBridge />", () => {
  beforeEach(() => {
    resetAuth("signed-in", "alice@example.com");
    __getOpenEpicRegistryForTests().disposeAll();
    __getChatSessionRegistryForTests().disposeAll();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __getChatSessionRegistryForTests().disposeAll();
    resetAuth("signed-out", null);
  });

  it("clears every live Epic and chat session on sign-out", () => {
    const epicRegistry = __getOpenEpicRegistryForTests();
    const chatRegistry = __getChatSessionRegistryForTests();
    const h1 = fakeOpenEpicHandle("e1");
    const h2 = fakeOpenEpicHandle("e2");
    const c1 = fakeChatHandle("e1", "c1", "alice@example.com");
    const c2 = fakeChatHandle("e2", "c2", "alice@example.com");
    epicRegistry.acquire("e1", () => h1);
    epicRegistry.acquire("e2", () => h2);
    chatRegistry.acquire(
      "e1",
      "c1",
      chatScope("alice@example.com"),
      () => c1.handle,
    );
    chatRegistry.acquire(
      "e2",
      "c2",
      chatScope("alice@example.com"),
      () => c2.handle,
    );
    expect(epicRegistry.size()).toBe(2);
    expect(chatRegistry.size()).toBe(2);

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    // Flip to signed-out.
    act(() => {
      resetAuth("signed-out", null);
    });

    expect(epicRegistry.size()).toBe(0);
    expect(chatRegistry.size()).toBe(0);
    expect(h1.disposeCount).toBe(1);
    expect(h2.disposeCount).toBe(1);
    expect(c1.closeCount()).toBe(1);
    expect(c2.closeCount()).toBe(1);
  });

  it("clears live sessions on user-switch and lets the next user reacquire fresh chat state", () => {
    const epicRegistry = __getOpenEpicRegistryForTests();
    const chatRegistry = __getChatSessionRegistryForTests();
    const h1 = fakeOpenEpicHandle("e1");
    const c1 = fakeChatHandle("e1", "c1", "alice@example.com");
    epicRegistry.acquire("e1", () => h1);
    chatRegistry.acquire(
      "e1",
      "c1",
      chatScope("alice@example.com"),
      () => c1.handle,
    );

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    // Flip to a different signed-in identity.
    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    expect(epicRegistry.size()).toBe(0);
    expect(chatRegistry.size()).toBe(0);
    expect(h1.disposeCount).toBe(1);
    expect(c1.closeCount()).toBe(1);

    const c2 = fakeChatHandle("e1", "c1", "bob@example.com");
    const nextChat = chatRegistry.acquire(
      "e1",
      "c1",
      chatScope("bob@example.com"),
      () => c2.handle,
    );

    expect(nextChat).toBe(c2.handle);
    expect(nextChat).not.toBe(c1.handle);
    expect(nextChat.userId).toBe("bob@example.com");
    expect(chatRegistry.size()).toBe(1);
    expect(c2.closeCount()).toBe(0);
  });

  it("does not clear sessions on the initial mount when already signed-in", () => {
    const epicRegistry = __getOpenEpicRegistryForTests();
    const chatRegistry = __getChatSessionRegistryForTests();
    const h1 = fakeOpenEpicHandle("e1");
    const c1 = fakeChatHandle("e1", "c1", "alice@example.com");
    epicRegistry.acquire("e1", () => h1);
    chatRegistry.acquire(
      "e1",
      "c1",
      chatScope("alice@example.com"),
      () => c1.handle,
    );

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    // Mounting the bridge while already signed-in is a hydration, not a
    // transition - existing sessions must stay alive.
    expect(epicRegistry.size()).toBe(1);
    expect(chatRegistry.size()).toBe(1);
    expect(h1.disposeCount).toBe(0);
    expect(c1.closeCount()).toBe(0);
  });
});
