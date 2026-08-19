import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

/** Chat sessions are keyed by (epic, chat, host); sign-out / user-switch
 *  teardown is host-agnostic, so one host id serves every fixture here. */
const CHAT_HOST_ID = "host-1";

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
    detachTransport: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => true,
    hotArtifactRoomIdsForTests: () => [],
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
      hostId: "host-a",
      epicId,
      chatId,
      userId,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
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
  userId: string | null,
): void {
  if (status === "signed-in" && email !== null && userId !== null) {
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

describe("<EpicSessionLifecycleBridge />", () => {
  beforeEach(() => {
    resetAuth("signed-in", "alice@example.com", "user-alice");
    __getOpenEpicRegistryForTests().disposeAll();
    __getChatSessionRegistryForTests().disposeAll();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __getChatSessionRegistryForTests().disposeAll();
    resetAuth("signed-out", null, null);
    // Module-level stores: without this a leaked pick or an open dialog would
    // travel between the cases below and the assertions would stop meaning
    // anything.
    useSettingsHostScopeStore.getState().setScopedHostId(null);
    useAddHostDialogStore.getState().closeDialog();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    useProvidersFocusStore.getState().clearFocusTab();
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
      {
        epicId: "e1",
        chatId: "c1",
        hostId: CHAT_HOST_ID,
        scopeKey: chatScope("alice@example.com"),
      },
      () => c1.handle,
    );
    chatRegistry.acquire(
      {
        epicId: "e2",
        chatId: "c2",
        hostId: CHAT_HOST_ID,
        scopeKey: chatScope("alice@example.com"),
      },
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
      resetAuth("signed-out", null, null);
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
      {
        epicId: "e1",
        chatId: "c1",
        hostId: CHAT_HOST_ID,
        scopeKey: chatScope("alice@example.com"),
      },
      () => c1.handle,
    );

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    // Flip to a different signed-in identity.
    act(() => {
      resetAuth("signed-in", "alice@example.com", "user-bob");
    });

    expect(epicRegistry.size()).toBe(0);
    expect(chatRegistry.size()).toBe(0);
    expect(h1.disposeCount).toBe(1);
    expect(c1.closeCount()).toBe(1);

    const c2 = fakeChatHandle("e1", "c1", "bob@example.com");
    const nextChat = chatRegistry.acquire(
      {
        epicId: "e1",
        chatId: "c1",
        hostId: CHAT_HOST_ID,
        scopeKey: chatScope("bob@example.com"),
      },
      () => c2.handle,
    );

    expect(nextChat).toBe(c2.handle);
    expect(nextChat).not.toBe(c1.handle);
    expect(nextChat.userId).toBe("bob@example.com");
    expect(chatRegistry.size()).toBe(1);
    expect(c2.closeCount()).toBe(0);
  });

  it("drops the Settings host scope on user-switch so it cannot name the prior account's machine", () => {
    // A host id belongs to an ACCOUNT. Carrying account A's pick into account
    // B's session opened Settings on a `vanished` host B has never seen and
    // cannot dismiss without re-picking. `null` restores "follow the active
    // host", which is the store's unset state, not an empty one.
    useSettingsHostScopeStore.getState().setScopedHostId("host-owned-by-alice");

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useSettingsHostScopeStore.getState().scopedHostId).toBeNull();
  });

  it("drops the Settings host scope on sign-out", () => {
    useSettingsHostScopeStore.getState().setScopedHostId("host-owned-by-alice");

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-out", null, null);
    });

    expect(useSettingsHostScopeStore.getState().scopedHostId).toBeNull();
  });

  it("closes the Add-host dialog and drops its fleet snapshot on user-switch", () => {
    // The dialog store is module-level and carries more than `open`:
    // `knownHostIds` is the snapshot its arrival watcher diffs against to
    // decide which machine is NEW. Reset only the scope and account B mounts
    // Settings into A's open dialog holding A's fleet — so a host B already
    // owns is absent from that snapshot and gets announced as the machine that
    // just connected.
    useAddHostDialogStore.getState().openDialog(["host-owned-by-alice"]);

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useAddHostDialogStore.getState().open).toBe(false);
    expect(useAddHostDialogStore.getState().knownHostIds).toEqual([]);
  });

  it("closes the Add-host dialog on sign-out", () => {
    useAddHostDialogStore.getState().openDialog(["host-owned-by-alice"]);

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-out", null, null);
    });

    expect(useAddHostDialogStore.getState().open).toBe(false);
  });

  it("drops a pending Providers deep-link intent on user-switch", () => {
    // The most dangerous of the three module-level stores on this boundary:
    // `focusHostId` names account A's machine and `startSignIn` asks Providers
    // to begin a sign-in the moment it consumes the intent. Left armed,
    // account B's Providers could select A's host id and then run A's pending
    // profile sign-in against whichever host B lands on.
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId: "claude",
      hostId: "host-owned-by-alice",
      profileId: "profile-alice",
      startSignIn: true,
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    const focus = useProvidersFocusStore.getState();
    expect(focus.focusHostId).toBeNull();
    expect(focus.focusProfileId).toBeNull();
    expect(focus.focusHarnessId).toBeNull();
    expect(focus.startSignIn).toBe(false);
  });

  it("leaves a pending Providers deep-link alone when the identity has not changed", () => {
    // The counterweight. A deep link is armed by a click and consumed on the
    // next Providers mount, so a bridge that cleared it on every render would
    // break the feature outright while still passing the case above.
    useProvidersFocusStore.getState().setProfileFocus({
      harnessId: "claude",
      hostId: "host-a",
      profileId: "profile-a",
      startSignIn: true,
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    expect(useProvidersFocusStore.getState().focusHostId).toBe("host-a");
    expect(useProvidersFocusStore.getState().startSignIn).toBe(true);
  });

  it("leaves an open Add-host dialog alone when the identity has not changed", () => {
    // The counterweight: without it, a bridge that closed the dialog on every
    // render would satisfy both cases above while making the dialog impossible
    // to keep open.
    useAddHostDialogStore.getState().openDialog(["host-a"]);

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    expect(useAddHostDialogStore.getState().open).toBe(true);
    expect(useAddHostDialogStore.getState().knownHostIds).toEqual(["host-a"]);
  });

  it("keeps the Settings host scope when the same identity merely re-mounts", () => {
    // The counterpart of the sessions case below: a hydration is not a
    // transition, so an explicit pick must survive it. Without this the two
    // assertions above would also pass for a bridge that cleared the scope on
    // every render.
    useSettingsHostScopeStore.getState().setScopedHostId("host-a");

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-a");
  });

  it("does not clear sessions on the initial mount when already signed-in", () => {
    const epicRegistry = __getOpenEpicRegistryForTests();
    const chatRegistry = __getChatSessionRegistryForTests();
    const h1 = fakeOpenEpicHandle("e1");
    const c1 = fakeChatHandle("e1", "c1", "alice@example.com");
    epicRegistry.acquire("e1", () => h1);
    chatRegistry.acquire(
      {
        epicId: "e1",
        chatId: "c1",
        hostId: CHAT_HOST_ID,
        scopeKey: chatScope("alice@example.com"),
      },
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
