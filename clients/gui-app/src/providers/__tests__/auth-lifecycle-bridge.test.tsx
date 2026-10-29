import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";

import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { newConversationSurfaceKey } from "@/stores/host/surface-host-selection-store";
import {
  useLandingReturnedSandbox,
  useNewConversationReturnedSandbox,
} from "@/hooks/sandboxes/use-returned-sandbox-stage";
import {
  recoverPendingSandboxSendsAfterTaskLoss,
  returnPendingSandboxSendOnItsSandbox,
} from "@/lib/sandboxes/pending-sandbox-send";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import { pendingSend } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  openSandboxDetails,
  useSandboxDetailsStore,
} from "@/stores/sandboxes/sandbox-details-store";
import {
  requestSandboxesPageConfiguration,
  useSandboxesPageStore,
} from "@/stores/sandboxes/sandboxes-page-store";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

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
    hostId: "test-host",
    // A production handle has no `doc` / `awareness`: the replica lives on
    // the worker thread and a `Y.Doc` cannot cross a structured clone.
    projection: {
      accept: () => null,
      apply: () => {},
      reject: () => {},
    },
    body: { applyDocUpdate: () => {}, applyAwareness: () => {} },
    store: {
      // The registry's eligibility key reads all three work fields plus the
      // transport; `as never` hides an omission, and an absent `isDirty`
      // would read as clean by accident rather than by the fixture saying so.
      getState: () =>
        ({
          isDirty: false,
          unsyncedQueueSize: 0,
          writeCommands: [],
          hostTransportStatus: "open",
          snapshotMeta: null,
        }) as never,
      subscribe: () => () => undefined,
    } as never,
    dispose: () => {
      h.disposeCount += 1;
    },
    detachTransport: () => undefined,
    requestFreshSnapshot: () => undefined,
    wakeTransport: () => undefined,
    isClean: () => true,
    hotArtifactRoomIdsForTests: () => [],
    ...INERT_ROOT_STATE_PORT,
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
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: "host-a",
      epicId,
      chatId,
      userId,
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
    // This one PERSISTS, so it needs both halves and in this order: the store
    // first, then the storage the persist middleware just rewrote. Two cases
    // below set it and rely on the bridge's own transition to clear it - a
    // case that fails or exits before that transition would otherwise hand the
    // next one a pick, and the sign-out assertions would pass on a leak.
    useWatchHostStore.setState({ scopedHostId: null });
    window.localStorage.clear();
    useAddHostDialogStore.getState().closeDialog();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    useProvidersFocusStore.getState().clearFocusTab();
    useProviderLinkDialogStore.getState().close();
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

  it("drops the shared watch-host pick on user-switch", () => {
    // Same account-owned rule as the Settings scope, and this one PERSISTS -
    // left standing it survives the restart into the next sign-in and opens
    // both watching surfaces on a host the new account has never seen.
    useWatchHostStore.getState().setScopedHostId("host-owned-by-alice");

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useWatchHostStore.getState().scopedHostId).toBeNull();
  });

  it("drops every staged sandbox on user-switch", () => {
    // Left standing, the next account would send into the outgoing
    // account's team, or resubmit its create key.
    useStagedSandboxStore.getState().stage("composer:w1", {
      kind: "existing",
      hostId: "host-owned-by-alice",
      sandboxId: "sbx-alice",
      name: "alice-box",
      configuration: { kind: "team", teamId: "team-alice", teamName: "Acme" },
      verb: "resume",
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useStagedSandboxStore.getState().bySurface).toEqual({});
  });

  describe("an account's accepted sandbox create across a switch", () => {
    const SEND_ID = "send-alice";
    const PENDING = pendingSendSurfaceKey(SEND_ID);
    const NEW_TARGET: StagedSandboxTarget = {
      kind: "new",
      configuration: { kind: "personal" },
      name: "build-box",
      wakeString: null,
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
    };
    const locks = Object.getOwnPropertyDescriptor(navigator, "locks");

    /** Alice's send, its create accepted by the server and not yet answered. */
    function acceptedCreate(): void {
      usePendingSandboxSendStore
        .getState()
        .add(pendingSend({ id: SEND_ID, userId: "user-alice" }));
      const staged = useStagedSandboxStore.getState();
      staged.stage(PENDING, NEW_TARGET);
      staged.report(PENDING, {
        phase: "creating",
        clientRequestId: "accepted-create",
      });
    }

    function switchTo(email: string, userId: string): void {
      act(() => resetAuth("signed-in", email, userId));
    }

    beforeEach(() => {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: (
            _name: string,
            _options: LockOptions,
            callback: () => Promise<void>,
          ) => callback(),
        },
      });
    });

    afterEach(() => {
      if (locks === undefined) Reflect.deleteProperty(navigator, "locks");
      else Object.defineProperty(navigator, "locks", locks);
      usePendingSandboxSendStore.setState({ sends: {} });
      useStagedSandboxStore.setState({ bySurface: {} });
      useNewConversationModalStore.getState().resetForTests();
    });

    it("keeps the send's stage and create key, through a reload, for its own account to take up again", async () => {
      acceptedCreate();
      const owner = holdPendingSandboxSendOwnership(SEND_ID);
      try {
        expect(await owner.ready).toBe(true);
        render(
          <EpicSessionLifecycleBridge>
            <div />
          </EpicSessionLifecycleBridge>,
        );

        switchTo("bob@example.com", "user-bob");
        switchTo("alice@example.com", "user-alice");
        // A reload: the window's memory is gone, storage is read back.
        const storage = window.localStorage;
        const saved = Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? "";
          return [key, storage.getItem(key) ?? ""] as const;
        });
        useStagedSandboxStore.setState({ bySurface: {} });
        storage.clear();
        for (const [key, value] of saved) storage.setItem(key, value);
        await useStagedSandboxStore.persist.rehydrate();

        expect(readStagedSandbox(PENDING)).toMatchObject({
          phase: "creating",
          target: NEW_TARGET,
          clientRequestId: "accepted-create",
        });
        expect(returnPendingSandboxSendOnItsSandbox(SEND_ID).kind).toBe("task");
        expect(
          useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
            ?.returnedSandbox,
        ).toMatchObject({
          target: NEW_TARGET,
          clientRequestId: "accepted-create",
        });
      } finally {
        owner.release();
      }
    });

    it("gives the next account nothing of it to see, stage, retry or take back", async () => {
      acceptedCreate();
      useStagedSandboxStore.getState().stage("composer:w1", NEW_TARGET);
      render(
        <EpicSessionLifecycleBridge>
          <div />
        </EpicSessionLifecycleBridge>,
      );

      switchTo("bob@example.com", "user-bob");
      const kept = readStagedSandbox(PENDING);
      renderHook(() => {
        useNewConversationReturnedSandbox("epic-1", null);
        useLandingReturnedSandbox("composer:w1", null, true);
      });
      const asBob = await useStagedSandboxStore
        .getState()
        .requestRetry(PENDING, "user-bob", "retry-creation");
      const asAlice = await useStagedSandboxStore
        .getState()
        .requestRetry(PENDING, "user-alice", "retry-creation");
      recoverPendingSandboxSendsAfterTaskLoss(["epic-1"], "user-bob");
      recoverPendingSandboxSendsAfterTaskLoss(["epic-1"], "user-alice");

      expect(Object.keys(useStagedSandboxStore.getState().bySurface)).toEqual([
        PENDING,
      ]);
      expect(readStagedSandbox(PENDING)).toBe(kept);
      expect(kept).toMatchObject({ clientRequestId: "accepted-create" });
      expect(readStagedSandbox(newConversationSurfaceKey("epic-1"))).toBeNull();
      expect(asBob).toBeNull();
      expect(asAlice).toBeNull();
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toBeUndefined();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toMatchObject({ userId: "user-alice", delivery: null });
    });
  });

  it("keeps an undelivered message waiting on a sandbox for its own account on user-switch, and drops a delivered one's ready line", () => {
    // Undelivered, the send is the message's only copy: it stays, for its
    // own account's driver alone, which gives it back on that account's next
    // sign-in. Delivered, only its ready line is left, and that goes.
    const settings = {
      harnessId: "codex",
      model: "gpt-6.1-sol",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    } as const;
    usePendingSandboxSendStore.getState().add({
      id: "send-alice-delivered",
      userId: "user-alice",
      epicId: "epic-alice",
      request: { kind: "chat", parentId: null, placement: null },
      content: { type: "doc", content: [] },
      text: "already sent",
      settings,
      createdAt: 900,
      epicConfirmed: true,
      delivery: {
        chatId: "chat-alice",
        hostId: "host-sbx",
        sandboxId: "sbx-alice",
        readySeconds: 24,
      },
    });
    usePendingSandboxSendStore.getState().add({
      id: "send-alice",
      userId: "user-alice",
      epicId: "epic-alice",
      request: { kind: "chat", parentId: null, placement: null },
      content: { type: "doc", content: [] },
      text: "fix the login bug",
      settings: {
        harnessId: "codex",
        model: "gpt-6.1-sol",
        permissionMode: "supervised",
        reasoningEffort: "high",
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
      createdAt: 1_000,
      epicConfirmed: true,
      delivery: null,
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual([
      "send-alice",
    ]);
    expect(
      usePendingSandboxSendStore.getState().sends["send-alice"],
    ).toMatchObject({ userId: "user-alice", text: "fix the login bug" });
  });

  it("drops a terminal a sandbox row asked the landing panel for on user-switch", () => {
    useLandingPanelStore
      .getState()
      .requestTerminal("landing:window-alice", "host-owned-by-alice");

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useLandingPanelStore.getState().terminalRequest).toBeNull();
  });

  it("closes the Details drawer and resets the Sandboxes page on user-switch", () => {
    openSandboxDetails("sbx-alice");
    requestSandboxesPageConfiguration({ kind: "team", teamId: "team-alice" });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useSandboxDetailsStore.getState().sandboxId).toBeNull();
    expect(useSandboxesPageStore.getState().requestedConfiguration).toBeNull();
  });

  it("drops the shared watch-host pick on sign-out", () => {
    useWatchHostStore.getState().setScopedHostId("host-owned-by-alice");

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-out", null, null);
    });

    expect(useWatchHostStore.getState().scopedHostId).toBeNull();
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

  it("closes the provider Link dialog on user-switch", () => {
    // The target names a provider profile of account A's; left open, account B
    // would see A's Link dialog and could run its sign-in under B's session.
    useProviderLinkDialogStore
      .getState()
      .open({ providerId: "claude", profileId: "profile-alice" });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useProviderLinkDialogStore.getState().target).toBeNull();
  });

  it("leaves an open provider Link dialog alone when the identity has not changed", () => {
    // The counterweight: a bridge that closed it on every render would
    // satisfy the user-switch case above while never letting it survive a
    // normal render.
    useProviderLinkDialogStore
      .getState()
      .open({ providerId: "claude", profileId: "profile-a" });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    expect(useProviderLinkDialogStore.getState().target).toEqual({
      providerId: "claude",
      profileId: "profile-a",
    });
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
