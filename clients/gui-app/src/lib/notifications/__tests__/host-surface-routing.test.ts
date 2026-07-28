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
});
