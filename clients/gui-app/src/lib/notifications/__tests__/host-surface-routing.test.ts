import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isNotificationPayloadRoutable,
  parseNotificationPayload,
  routeNotification,
} from "@/lib/notifications/payload";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import {
  DEFAULT_WORKTREE_SORT_MODE,
  EMPTY_WORKTREE_TIER_FILTERS,
  useWorktreesSettingsViewStore,
} from "@/stores/settings/worktrees-settings-view-store";
import {
  chatTranscriptJumpKey,
  useChatTranscriptJumpStore,
} from "@/stores/chats/chat-transcript-jump-store";
import { useWorktreeCleanupViewStore } from "@/stores/settings/worktree-cleanup-view-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/**
 * The `hostSurface` destination family: a notification about a host-managed
 * resource opens a host surface, not a document inside an epic.
 */
describe("host surface notification routing", () => {
  beforeEach(async () => {
    __resetTabNavigationControllerForTesting();
    __resetTabSyncCoordinatorForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    useTabsStore.getState().closeSystemTab("settings");
    useWorktreesSettingsViewStore.setState({
      searchText: "",
      sortMode: DEFAULT_WORKTREE_SORT_MODE,
      tierFilters: EMPTY_WORKTREE_TIER_FILTERS,
    });
    useChatTranscriptJumpStore.setState({ requestsByChatId: {} });
    useWorktreeCleanupViewStore.setState({
      view: "settings",
      focusedRunId: null,
    });
    useSettingsHostScopeStore.setState({ scopedHostId: null });
  });

  it("opens Settings → Worktrees and remembers the section on the tab", () => {
    const navigate = vi.fn();
    routeNotification(
      navigate,
      { kind: "hostSurface", surface: "worktreeSettings", focus: undefined },
      1_000,
    );

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/settings/worktrees" }),
    );
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/worktrees",
    );
  });

  it("leaves the panel's saved search, sort, and tier filters untouched", () => {
    const view = useWorktreesSettingsViewStore.getState();
    view.setSearchText("acme/api");
    view.toggleTierFilter("merged");
    const before = useWorktreesSettingsViewStore.getState();

    routeNotification(
      vi.fn(),
      { kind: "hostSurface", surface: "worktreeSettings", focus: undefined },
      1_000,
    );

    // Filters live in a panel-scoped store rather than the route, so
    // activation returns the user to the list they had set up - the row must
    // not smuggle a view reset in through navigation.
    const after = useWorktreesSettingsViewStore.getState();
    expect(after.searchText).toBe("acme/api");
    expect(after.sortMode).toBe(before.sortMode);
    expect([...after.tierFilters]).toEqual([...before.tierFilters]);
  });

  // Forward-compatibility placeholder, NOT coverage of focus-resolution
  // logic: `focus` is parsed and typed but no surface consumes it yet, and no
  // producer emits one. The router dispatches on `surface` alone, so a hint it
  // cannot use is structurally incapable of blocking navigation. This pins
  // that property so the first surface to actually READ a hint has to keep
  // the parent-surface fallback rather than inherit a dead-end activation.
  it("ignores a focus hint it cannot use and still opens the parent surface", () => {
    const navigate = vi.fn();
    routeNotification(
      navigate,
      {
        kind: "hostSurface",
        surface: "worktreeSettings",
        focus: { resourceId: "worktree-deleted-an-hour-ago" },
      },
      1_000,
    );

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/settings/worktrees" }),
    );
  });

  it("is routable with or without a focus hint", () => {
    expect(
      isNotificationPayloadRoutable({
        kind: "hostSurface",
        surface: "worktreeSettings",
        focus: undefined,
      }),
    ).toBe(true);
    expect(
      isNotificationPayloadRoutable({
        kind: "hostSurface",
        surface: "worktreeSettings",
        focus: { resourceId: "gone" },
      }),
    ).toBe(true);
  });

  it("parses a native activation envelope's host-surface route, and degrades on an unknown surface", () => {
    expect(
      parseNotificationPayload({
        kind: "hostSurface",
        surface: "worktreeSettings",
      }),
    ).toEqual({
      kind: "hostSurface",
      surface: "worktreeSettings",
      focus: undefined,
    });
    // A surface only a NEWER build knows must open the notification centre
    // rather than resolve to a guessed route.
    expect(
      parseNotificationPayload({ kind: "hostSurface", surface: "testBoxes" }),
    ).toBeNull();
  });

  // `view` narrows a destination that already works without it, so both
  // directions of the version skew have to stay non-fatal: a newer producer's
  // view must survive the parse, and a view this build does not know must
  // degrade to the surface's default rather than reject the whole route.
  it("parses a known host-surface view and degrades on an unknown one", () => {
    expect(
      parseNotificationPayload({
        kind: "hostSurface",
        surface: "worktreeSettings",
        view: "cleanupHistory",
        focus: { resourceId: "run-42" },
      }),
    ).toEqual({
      kind: "hostSurface",
      surface: "worktreeSettings",
      view: "cleanupHistory",
      focus: { resourceId: "run-42" },
    });
    expect(
      parseNotificationPayload({
        kind: "hostSurface",
        surface: "worktreeSettings",
        view: "someFutureView",
      }),
    ).toEqual({
      kind: "hostSurface",
      surface: "worktreeSettings",
      view: undefined,
      focus: undefined,
    });
  });

  it("opens the cleanup-history sub-view focused on the run, on that run's host", () => {
    const navigate = vi.fn();
    routeNotification(
      navigate,
      {
        kind: "hostSurface",
        surface: "worktreeSettings",
        view: "cleanupHistory",
        hostId: "host-b",
        focus: { resourceId: "run-42" },
      },
      1_000,
    );

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/settings/worktrees" }),
    );
    expect(useWorktreeCleanupViewStore.getState()).toMatchObject({
      view: "cleanupHistory",
      focusedRunId: "run-42",
    });
    // History is host-local, so the destination is only well defined once
    // Settings is administering the host the run happened on.
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-b");
  });

  it("still opens history when the run id cannot be resolved", () => {
    routeNotification(
      vi.fn(),
      {
        kind: "hostSurface",
        surface: "worktreeSettings",
        view: "cleanupHistory",
        hostId: "host-b",
        focus: undefined,
      },
      1_000,
    );

    // A focus hint is allowed to miss; the view it names is not a dead end.
    expect(useWorktreeCleanupViewStore.getState()).toMatchObject({
      view: "cleanupHistory",
      focusedRunId: null,
    });
  });

  /**
   * The manual worktree-deletion row is UNCHANGED by the cleanup work: same
   * payload shape, same destination, no host retarget, and the inventory - not
   * the new sub-view - is what it lands on even when history is what the panel
   * happened to be showing.
   */
  it("leaves a manual worktree-deletion row's behavior exactly as it was", () => {
    useWorktreeCleanupViewStore.getState().openHistory("run-42");
    useSettingsHostScopeStore.getState().setScopedHostId("host-a");
    const navigate = vi.fn();

    const payload = parseNotificationPayload({
      kind: "hostSurface",
      surface: "worktreeSettings",
    });
    expect(payload).toEqual({
      kind: "hostSurface",
      surface: "worktreeSettings",
      focus: undefined,
    });
    if (payload === null) throw new Error("expected a host-surface payload");
    routeNotification(navigate, payload, 1_000);

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/settings/worktrees" }),
    );
    expect(useTabsStore.getState().systemTabs.settings?.lastPath).toBe(
      "/settings/worktrees",
    );
    // No `hostId` on the row means no retarget: the user keeps administering
    // whichever host they were already on.
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-a");
    expect(useWorktreeCleanupViewStore.getState()).toMatchObject({
      view: "settings",
      focusedRunId: null,
    });
  });

  it("does not park an unscoped transcript jump on the hostless fallback", () => {
    const navigate = vi.fn();

    routeNotification(
      navigate,
      {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        messageId: "message-with-provider-error",
      },
      1_000,
    );

    expect(useChatTranscriptJumpStore.getState().requestsByChatId).toEqual({});
    expect(navigate).toHaveBeenCalled();
  });

  it("parses a chat failure's durable event anchor", () => {
    expect(
      parseNotificationPayload({
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        eventId: "queued-preparation-failure",
      }),
    ).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      messageId: undefined,
      eventId: "queued-preparation-failure",
    });
  });

  it("turns only an unqualified completed chat payload into an end jump", () => {
    expect(
      parseNotificationPayload({
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        outcome: "completed",
        backgroundWorkRunning: false,
        messageId: "qualified-done-anchor",
      }),
    ).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      messageId: undefined,
      eventId: undefined,
      scrollToEnd: true,
    });
    expect(
      parseNotificationPayload({
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        outcome: "completed",
        backgroundWorkRunning: true,
        messageId: "qualified-done-anchor",
      }),
    ).toEqual({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      messageId: "qualified-done-anchor",
      eventId: undefined,
    });
  });

  it("isolates same-id transcript jumps by origin host", () => {
    const store = useChatTranscriptJumpStore.getState();
    store.requestJump("host-a", "chat-1", {
      kind: "message",
      messageId: "message-a",
    });
    store.requestJump("host-b", "chat-1", {
      kind: "message",
      messageId: "message-b",
    });

    const state = useChatTranscriptJumpStore.getState();
    const hostAKey = chatTranscriptJumpKey("host-a", "chat-1");
    const hostBKey = chatTranscriptJumpKey("host-b", "chat-1");
    expect(state.requestsByChatId[hostAKey]?.target).toEqual({
      kind: "message",
      messageId: "message-a",
    });
    expect(state.requestsByChatId[hostBKey]?.target).toEqual({
      kind: "message",
      messageId: "message-b",
    });

    const hostARequestId = state.requestsByChatId[hostAKey]?.requestId;
    expect(hostARequestId).toBeDefined();
    if (hostARequestId === undefined) return;
    state.consumeJump("host-a", "chat-1", hostARequestId);
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[hostBKey],
    ).toBeDefined();
  });
});
