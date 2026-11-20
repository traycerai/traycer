/**
 * The Tracy surface and the signed-in account (T186), for the channel's own
 * state across an account switch and for what the channel's parents hold of a
 * send. The tree, the host client and the per-case lifecycle are in
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
import type { Mutation } from "@tanstack/react-query";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import {
  answerDraftKey,
  useBotDraftsStore,
} from "@/stores/bots/bot-drafts-store";
import {
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import { botMutationKeys } from "@/lib/query-keys/bot-mutation-keys";
import {
  chatSessionWithThreadRows,
  postRow,
} from "@/components/bots/__tests__/bot-channel-rows-test-support";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  activityStore,
  CHANNEL,
  channelBox,
  installIdentityCaseLifecycle,
  mountSurface,
  queryClient,
  question,
  refusedEditWithMovedAnswer,
  refuseHeldSend,
  sent,
  setHoldSends,
  setRefuseSends,
  signInAs,
  signOut,
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

describe("<BotTabSurface /> the channel's state across an account switch", () => {
  it("shows account B an empty box, with no edit and none of A's answer, when A's refused replacement was put back as an edit before the switch", async () => {
    await refusedEditWithMovedAnswer();

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-channel-composer-editing")).toBeNull();
    const state = useBotDraftsStore.getState();
    expect(JSON.stringify(state)).not.toContain("Hold the migration");
    expect(JSON.stringify(state)).not.toContain("Failed text");
    expect(
      localStorage.getItem(botBoxDraftsKey(ACCOUNT_B)) ?? "",
    ).not.toContain("Hold the migration");
    void answerDraftKey;
  });

  it("gives the answer back to the channel's box, once, when the person cancels the edit a refused replacement resumed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await refusedEditWithMovedAnswer();

    await user.click(screen.getByTestId("bot-channel-composer-edit-cancel"));

    expect(textOf(channelBox())).toBe("Hold the migration");
  });

  it("gives A the newer draft followed by the failed message, with the moved answer once, when A signs out and signs in again after the send that carried the answer failed beside a newer draft", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setHoldSends(true);
    const handle = chatSessionWithThreadRows([question(false)]);
    channelHandles.handles.set(CHANNEL, handle);
    mountSurface();
    await user.type(
      within(await screen.findByTestId("question-card")).getByRole("textbox", {
        name: "Your answer",
      }),
      "Hold the migration",
    );
    act(() => handle.store.setState({ messages: [question(true)] }));
    await vi.waitFor(() =>
      expect(textOf(channelBox())).toBe("Hold the migration"),
    );
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    typeInto(channelBox(), "Newer draft");
    act(() => refuseHeldSend?.());
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("bot-channel-composer-send-failed"),
      ).toBeTruthy(),
    );

    signOut();
    signInAs(ACCOUNT_A);

    await vi.waitFor(() =>
      expect(textOf(channelBox())).toBe("Newer draft\n\nHold the migration"),
    );
  });
});

describe("<BotTabSurface /> what the channel's parents hold of a send, across an account switch", () => {
  it("shows account B no couldn't-send line under its box when A's send failed before the switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setRefuseSends(true);
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    mountSurface();
    await screen.findByTestId("bot-channel-composer-input");
    expect(
      screen
        .getByRole("group", { name: "Message Release Bot" })
        .contains(channelBox()),
    ).toBe(true);
    typeInto(channelBox(), "Hello from A");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("bot-channel-composer-send-failed"),
      ).toBeTruthy(),
    );

    signInAs(ACCOUNT_B);

    await vi.waitFor(() => expect(textOf(channelBox())).toBe(""));
    expect(screen.queryByTestId("bot-channel-composer-send-failed")).toBeNull();
  });

  it("clears A's settled sends from the mutation cache at the switch, and keeps a send still out", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const sends = (): Mutation[] =>
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: botMutationKeys.conversationSend() });
    channelHandles.handles.set(
      CHANNEL,
      chatSessionWithThreadRows([postRow("post-1", "An earlier post")]),
    );
    mountSurface();
    await screen.findByTestId("bot-channel-composer-input");
    setRefuseSends(true);
    typeInto(channelBox(), "First");
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() =>
      expect(sends().some((send) => send.state.status === "error")).toBe(true),
    );
    setRefuseSends(false);
    setHoldSends(true);
    await vi.waitFor(() => expect(textOf(channelBox())).toBe("First"));
    await user.click(screen.getByTestId("bot-channel-composer-send"));
    await vi.waitFor(() =>
      expect(sends().some((send) => send.state.status === "pending")).toBe(
        true,
      ),
    );

    signInAs(ACCOUNT_B);

    await vi.waitFor(() =>
      expect(sends().filter((send) => send.state.status !== "pending")).toEqual(
        [],
      ),
    );
    expect(
      sends().filter((send) => send.state.status === "pending"),
    ).toHaveLength(1);
  });
});
