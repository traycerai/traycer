/**
 * The Tracy surface and the signed-in account (T186), for what the tree shows
 * at the commit an identity change lands in and for the account's stored
 * drafts. The tree, the host client and the per-case lifecycle are in
 * `bot-tab-surface-identity-harness.tsx`.
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { channelHandles } from "./bot-tab-surface-identity-state";
import {
  chatMessagesMock,
  chatSessionRegistryMock,
  composerProbeMock,
  landingImageStoreMock,
} from "./bot-tab-surface-identity-mocks";
import { emptyBotMentionHostListsMock } from "@/components/bots/__tests__/bot-mention-host-test-support";
import { useEffect, type ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import {
  editableIn,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS } from "@/lib/bots/bot-box-draft-storage";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  boxDoc,
  failFirstReadOf,
  hashedImage,
  storeImageBytes,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";
import {
  chatSessionWithThreadRows,
  postRow,
} from "@/components/bots/__tests__/bot-channel-rows-test-support";
import { BOT_ID } from "./bot-tab-surface-harness";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  activityStore,
  CHANNEL,
  channelBox,
  channelRows,
  FAILED_ON_POST,
  installIdentityCaseLifecycle,
  listedThreadOf,
  mountSurface,
  question,
  refusedEditWithMovedAnswer,
  signInAs,
  signOut,
  surfaceTree,
} from "./bot-tab-surface-identity-harness";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({
    history: { subscribe: () => () => undefined, canGoBack: () => false },
  }),
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => channelHandles.client,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
    usePaneFocused: () => true,
    usePaneFocusProbe: () => () => true,
  }),
);
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
// The channel sends through the real mutation; only the surface's own `bot.open` is scripted.
vi.mock("@/hooks/bots/use-bot-mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-mutations")>()),
  useBotOpenMutation: () => mocks.openMutation,
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => null,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => null,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => null,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => null,
}));
vi.mock("@/components/bots/bot-message-composer", async (importOriginal) =>
  composerProbeMock(
    await importOriginal<
      typeof import("@/components/bots/bot-message-composer")
    >(),
  ),
);
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) =>
  landingImageStoreMock(
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>(),
  ),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) =>
  chatSessionRegistryMock(
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >(),
  ),
);
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: "conversation-app" }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => activityStore((state) => state.activity),
}));
vi.mock("@/components/chat/chat-messages", () => chatMessagesMock());

installIdentityCaseLifecycle();

/** The session turns unverified as `userId`: the same account kept from disk, another than the one signed in. */
function turnUnverifiedAs(userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "unverified",
      signedOutCause: null,
      signingInAttempt: null,
      profile: {
        userId,
        userName: userId,
        email: `${userId}@example.com`,
        avatarUrl: null,
      },
      contextMetadata: { userId, username: userId },
    });
  });
}

describe("<BotTabSurface /> what the tree shows at the commit an identity change lands in", () => {
  /** The viewer's failed post, Edit pressed: A's box is editing it, with a draft typed after. */
  async function editingAFailedPost(): Promise<HTMLElement> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    activityStore.setState({
      activity: { trunk: FAILED_ON_POST, threads: {} },
    });
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows(channelRows(false)),
    );
    mountSurface();
    await user.click(await screen.findByTestId("bot-message-edit"));
    typeInto(channelBox(), " more");
    expect(textOf(channelBox())).toBe("Failed text more");
    return channelBox();
  }

  function expectKept(box: HTMLElement, generation: number): void {
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(channelBox()).toBe(box);
    expect(textOf(channelBox())).toBe("Failed text more");
    expect(screen.getByTestId("bot-channel-composer-editing")).toBeTruthy();
    expect(useBotDraftsStore.getState().generation).toBe(generation);
  }

  it("never shows viewer B any of A's content, at any render or layout effect, on a direct switch from A to B", async () => {
    await refusedEditWithMovedAnswer();
    channelHandles.observed.length = 0;

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(
      channelHandles.observed.filter(
        (seen) => seen.viewer === ACCOUNT_B && seen.markers.length > 0,
      ),
    ).toEqual([]);
  });

  it("never shows a signed-out viewer any of A's content, at any render or layout effect, when A signs out", async () => {
    await refusedEditWithMovedAnswer();
    channelHandles.observed.length = 0;

    signOut();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });

    expect(
      channelHandles.observed.filter(
        (seen) => seen.viewer === null && seen.markers.length > 0,
      ),
    ).toEqual([]);
    // Once the sign-out has settled the tab shows its tree, not the connecting state.
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(textOf(channelBox())).toBe("");
  });

  it("keeps A's tree, box, edit and draft through a sign-in attempt in flight, a failed attempt and A admitted again, with no connecting state and no retirement", async () => {
    const box = await editingAFailedPost();
    const generation = useBotDraftsStore.getState().generation;

    act(() => useAuthStore.getState().setSigningIn("device"));
    expectKept(box, generation);

    act(() =>
      useAuthStore.setState({
        status: "signed-out",
        signedOutCause: "attempt-failed",
        signingInAttempt: null,
        profile: null,
        contextMetadata: null,
      }),
    );
    expectKept(box, generation);

    signInAs(ACCOUNT_A);
    expectKept(box, generation);
  });

  it("keeps A's tree, box, edit and draft when the same account's session turns unverified, with no connecting state and no retirement", async () => {
    const box = await editingAFailedPost();
    const generation = useBotDraftsStore.getState().generation;

    act(() => useAuthStore.setState({ status: "unverified" }));

    expectKept(box, generation);
  });
});

describe("<BotTabSurface /> the account's stored drafts and the bot tab (T186)", () => {
  /** A's stored draft of the channel box. */
  function storedChannelDraft(
    text: string,
    content: JsonContent | null,
  ): string {
    return JSON.stringify({
      state: {
        threadBoxes: { [BOT_ID]: { [CHANNEL]: { text, content, seedId: 1 } } },
      },
      version: 1,
    });
  }

  it("opens the tab while A's stored draft with an image is still being read, holding that box read-only with A's stored text, then gives the box A's stored text and image to edit", async () => {
    installFreshIndexedDb();
    const hash = await storeImageBytes();
    const gate = Promise.withResolvers<void>();
    channelHandles.imageGates.set(hash, gate);
    localStorage.setItem(
      botBoxDraftsKey(ACCOUNT_A),
      storedChannelDraft(
        "A stored draft",
        boxDoc("A stored draft ", [hashedImage(hash)]),
      ),
    );
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );

    mountSurface();

    const waiting = await screen.findByTestId("bot-channel-composer-input");
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(waiting).toHaveProperty("value", "A stored draft");
    expect(waiting).toHaveProperty("disabled", true);
    expect(waiting).toHaveProperty("readOnly", true);
    expect(screen.getByTestId("bot-channel-composer-send")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("bot-channel-composer-reading").textContent).toBe(
      "This draft's images are still loading.",
    );

    gate.resolve();

    await vi.waitFor(() =>
      expect(textOf(channelBox())).toContain("A stored draft"),
    );
    expect(screen.queryByTestId("bot-channel-composer-reading")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(
      JSON.stringify(
        useBotDraftsStore.getState().threadBoxes[BOT_ID]?.[CHANNEL]?.content,
      ),
    ).toContain("b64content");
  });

  it("comes up with an empty box, not stuck connecting, when A's stored read throws, and leaves A's stored draft in place when the person types before it is read again", async () => {
    const keyOfA = botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(keyOfA, storedChannelDraft("A's stored draft", null));
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    failFirstReadOf(keyOfA);

    mountSurface();

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    typeInto(channelBox(), "typed while unread");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS);
    });
    signOut();
    expect(localStorage.getItem(keyOfA) ?? "").toContain("A's stored draft");
  });

  it("comes up, and keeps the person's draft, when A's stored value is not JSON: a value nothing can parse is absent, not unread", async () => {
    const keyOfA = botBoxDraftsKey(ACCOUNT_A);
    localStorage.setItem(keyOfA, "{not json");
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );

    mountSurface();

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    typeInto(channelBox(), "typed over junk");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS);
    });
    expect(localStorage.getItem(keyOfA) ?? "").toContain("typed over junk");
  });

  it("comes up at once, with no read, when the signed-in identity has no account id", async () => {
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    act(() =>
      useAuthStore.setState({
        status: "signed-in",
        signedOutCause: null,
        signingInAttempt: null,
        profile: null,
        contextMetadata: null,
      }),
    );
    const storage = useBotDraftsStore.persist.getOptions().storage;
    if (storage === undefined) throw new Error("the drafts store persists");
    const reads = vi.spyOn(storage, "getItem");
    onTestFinished(() => reads.mockRestore());

    mountSurface();

    await screen.findByTestId("bot-channel-composer-input");
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it("comes up at once, with no read, when nobody is signed in", async () => {
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    signOut();
    const storage = useBotDraftsStore.persist.getOptions().storage;
    if (storage === undefined) throw new Error("the drafts store persists");
    const reads = vi.spyOn(storage, "getItem");
    onTestFinished(() => reads.mockRestore());

    mountSurface();

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it("never shows viewer B any of the drafts store's content, at any render or layout effect, on a direct switch from A while A's card answer is still unsent", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([question(false)]),
    );
    mountSurface();
    await user.type(
      within(await screen.findByTestId("question-card")).getByRole("textbox", {
        name: "Your answer",
      }),
      "Hold the migration",
    );
    expect(JSON.stringify(useBotDraftsStore.getState().answers)).toContain(
      "Hold the migration",
    );
    channelHandles.observed.length = 0;

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(
      channelHandles.observed.filter(
        (seen) => seen.viewer === ACCOUNT_B && seen.markers.length > 0,
      ),
    ).toEqual([]);
  });

  describe("a sign-in attempt that starts while the stored drafts of the account the session turned to are being read", () => {
    /** Fails the attempt the commit after the bridge saw it start, as an attempt that does not go through does. */
    function FailsTheAttempt(): null {
      const status = useAuthStore((state) => state.status);
      useEffect(() => {
        if (status !== "signing-in") return;
        useAuthStore.setState({
          status: "signed-out",
          signedOutCause: "attempt-failed",
          signingInAttempt: null,
          profile: null,
          contextMetadata: null,
        });
      }, [status]);
      return null;
    }

    /**
     * B's stored channel draft is `stored`, the tab is open for A, and the
     * session turns unverified as B; the sign-in attempt starts inside the
     * store's own change to B, before anything can render, as the read of a
     * draft with no image is only microtasks wide. `beside` is rendered after
     * the surface, so its effects run after the bridge's.
     */
    async function onSwitchToB(
      stored: string,
      beside: ReactNode,
    ): Promise<void> {
      localStorage.setItem(botBoxDraftsKey(ACCOUNT_B), stored);
      channelHandles.handles.set(
        CHANNEL,
        chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
      );
      render(
        <>
          {surfaceTree()}
          {beside}
        </>,
      );
      await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
      channelHandles.commits.length = 0;
      const stop = useBotDraftsStore.subscribe((state) => {
        if (state.owner?.userId === ACCOUNT_B && !state.ownDraftsRead) {
          stop();
          useAuthStore.getState().setSigningIn("device");
        }
      });
      onTestFinished(stop);
      turnUnverifiedAs(ACCOUNT_B);
    }

    /** No box was shown for B before B's own stored text was read. */
    function expectNoBoxBeforeBsDraftsAreRead(): void {
      expect(channelHandles.commits.filter((commit) => !commit.read)).toEqual(
        [],
      );
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    }

    it.each([
      ["in flight", null],
      ["failed", <FailsTheAttempt key="fails" />],
    ])(
      "shows no box for B before B's stored text is in the store, then B's stored text, when the attempt is %s",
      async (_attempt, beside) => {
        await onSwitchToB(storedChannelDraft("B's stored draft", null), beside);

        await vi.waitFor(() =>
          expect(textOf(channelBox())).toContain("B's stored draft"),
        );
        // The box was committed for B at all, and only once its text was read.
        expect(channelHandles.commits.length).toBeGreaterThan(0);
        expectNoBoxBeforeBsDraftsAreRead();
      },
    );

    // The text of a draft that names an image is read in the store's own
    // synchronous step, so no commit can fall between the account changing
    // and its text being there: these two hold without the admission change.
    it.each([
      ["in flight", null],
      ["failed", <FailsTheAttempt key="fails" />],
    ])(
      "shows B's box waiting for its image on its own, with B's stored text and no box before it, when the attempt is %s and B's draft names an image still being read",
      async (_attempt, beside) => {
        installFreshIndexedDb();
        const hash = await storeImageBytes();
        channelHandles.imageGates.set(hash, Promise.withResolvers<void>());
        await onSwitchToB(
          storedChannelDraft(
            "B's stored draft",
            boxDoc("B's stored draft ", [hashedImage(hash)]),
          ),
          beside,
        );

        await screen.findByTestId("bot-channel-composer-reading");
        expect(screen.getByTestId("bot-channel-composer-input")).toHaveProperty(
          "value",
          "B's stored draft",
        );
        expectNoBoxBeforeBsDraftsAreRead();
      },
    );

    it("leaves B's stored draft as it is, and shows an empty box once the read has ended, when B's stored read throws during the attempt", async () => {
      const keyOfB = botBoxDraftsKey(ACCOUNT_B);
      const stored = storedChannelDraft("B's stored draft", null);
      failFirstReadOf(keyOfB);
      await onSwitchToB(stored, null);

      await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
      expectNoBoxBeforeBsDraftsAreRead();
      typeInto(channelBox(), "typed while unread");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOT_BOX_DRAFT_WRITE_DEBOUNCE_MS);
      });
      expect(localStorage.getItem(keyOfB)).toBe(stored);
    });

    it("keeps the tab open when an attempt starts after the session signed out, with nobody's drafts in the store", async () => {
      channelHandles.handles.set(
        CHANNEL,
        chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
      );
      mountSurface();
      await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
      signOut();
      expect(useBotDraftsStore.getState().owner).toBeNull();

      act(() => useAuthStore.getState().setSigningIn("device"));

      expect(textOf(channelBox())).toBe("");
      expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    });
  });

  it("opens the thread box for editing as soon as its own image is read, while the channel box still waits for its own", async () => {
    installFreshIndexedDb();
    const channelHash = await storeImageBytes();
    const { putImage } = await import("@/lib/composer/landing-image-store");
    const threadHash = await putImage(new Uint8Array([9, 8, 7, 6]));
    // The channel's image read is held until the thread box has opened.
    const channelGate = Promise.withResolvers<void>();
    channelHandles.imageGates.set(channelHash, channelGate);
    const threadGate = Promise.withResolvers<void>();
    channelHandles.imageGates.set(threadHash, threadGate);
    localStorage.setItem(
      botBoxDraftsKey(ACCOUNT_A),
      JSON.stringify({
        state: {
          threadBoxes: {
            [BOT_ID]: {
              [CHANNEL]: {
                text: "Channel draft",
                content: boxDoc("Channel draft ", [hashedImage(channelHash)]),
                seedId: 1,
              },
              "post-1": {
                text: "Thread draft",
                content: boxDoc("Thread draft ", [hashedImage(threadHash)]),
                seedId: 1,
              },
            },
          },
        },
        version: 1,
      }),
    );
    mocks.state.threads = [listedThreadOf("thread-1", "post-1")];
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "Ship it?")]),
    );
    channelHandles.handles.set(
      "thread-1",
      chatSessionWithThreadRows([postRow("reply-1", "A reply")]),
    );
    act(() =>
      useBotOpenThreadStore.getState().setRail(BOT_ID, {
        kind: "thread",
        anchorMessageId: "post-1",
        announcement: false,
        anchorKind: null,
        sent: null,
      }),
    );

    mountSurface();

    expect(
      await screen.findByTestId("bot-thread-composer-reading"),
    ).toBeTruthy();
    expect(screen.getByTestId("bot-channel-composer-reading")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();

    threadGate.resolve();

    await vi.waitFor(() =>
      expect(screen.queryByTestId("bot-thread-composer-reading")).toBeNull(),
    );
    const panel = screen.getByTestId("bot-thread-panel");
    expect(
      textOf(
        editableIn(within(panel).getByTestId("bot-thread-composer-input")),
      ),
    ).toContain("Thread draft");
    expect(screen.getByTestId("bot-thread-composer-send")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByTestId("bot-channel-composer-reading")).toBeTruthy();
    expect(screen.getByTestId("bot-channel-composer-input")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("bot-channel-composer-send")).toHaveProperty(
      "disabled",
      true,
    );

    channelGate.resolve();

    await vi.waitFor(() =>
      expect(screen.queryByTestId("bot-channel-composer-reading")).toBeNull(),
    );
    expect(textOf(channelBox())).toContain("Channel draft");
    expect(screen.getByTestId("bot-channel-composer-send")).toHaveProperty(
      "disabled",
      false,
    );
  });
});
