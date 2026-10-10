import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_ARCHIVE_VISIBILITY,
  CHAT_OWNERSHIP,
  DEFAULT_LEFT_PANEL_ID,
  DEFAULT_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  matchesChatOwnershipFilter,
  useLeftPanelStore,
  useChatArchiveVisibility,
  type ArtifactFilter,
  type ChatFilter,
} from "../left-panel-store";
import type {
  LeftPanelId,
  PanelVisibilityOverrideById,
} from "@/lib/left-panel-ids";
import {
  applyRail,
  currentLayoutArrangement,
  setRailVisibilityOverride,
  useLayoutRail,
} from "@/lib/layout/rail-view";
import {
  DEFAULT_RAIL,
  panelVisibilityOverridesFromValues,
  visibleRailPanelIds,
  type RailEntry,
} from "@/lib/layout/rail";
import { moveRailPanelBeside } from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSidebarRailWidthStore } from "@/stores/epics/sidebar-rail-width-store";

const PERSIST_KEY = "traycer-gui-app:left-panel";
const LAYOUT_PERSIST_KEY = "traycer-gui-app:layout";

/**
 * The rail's show/hide as the sidebar reads it.
 *
 * It lives in the layout store now (one region per rail panel, three-state),
 * and the sparse boolean map is what that resolves to - so a test asserts the
 * map the render paths take, off the store that holds it.
 */
function visibilityOverrides(): PanelVisibilityOverrideById {
  const state = useLayoutStore.getState();
  return panelVisibilityOverridesFromValues(
    effectiveLayoutValues(state.basePreset, state.overrides),
  );
}

/** The layout store's own persisted overrides, which now hold the rail's show/hide. */
function readPersistedLayoutOverrides(): Readonly<Record<string, unknown>> {
  const raw = window.localStorage.getItem(LAYOUT_PERSIST_KEY);
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const state: unknown = (parsed as { readonly state?: unknown }).state;
  if (typeof state !== "object" || state === null) return {};
  const overrides: unknown = (state as { readonly overrides?: unknown })
    .overrides;
  if (typeof overrides !== "object" || overrides === null) return {};
  return overrides as Readonly<Record<string, unknown>>;
}

function resetLayoutStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
}

/** Every panel the rail holds, hiding nothing. */
function railPanelIds(
  rail: ReadonlyArray<RailEntry>,
): ReadonlyArray<LeftPanelId> {
  return visibleRailPanelIds(rail, () => true);
}

/** The rail as the store holds it right now. */
function currentRail(): ReadonlyArray<RailEntry> {
  return currentLayoutArrangement().rail;
}

/**
 * Move one panel beside another through the public pipeline (the DnD commit
 * path): resolve the next rail with the arrangement's own mover, then commit
 * it atomically via `applyRail`.
 */
function movePanelBeside(
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  placeAfter: boolean,
): void {
  applyRail(
    moveRailPanelBeside(currentLayoutArrangement(), {
      sourcePanelId,
      targetPanelId,
      placeAfter,
      carry: "panel",
    }).rail,
  );
}

interface PersistedLeftPanelState {
  readonly state: {
    readonly activePanelIdByTabId: Readonly<Record<string, string>>;
    readonly mainCollapsedByTabId: Readonly<Record<string, boolean>>;
    readonly sidebarWidthPx: number;
    readonly panelSectionCollapsedByPanelId: Readonly<Record<string, boolean>>;
    readonly panelSectionWeightsByPanelId: Readonly<Record<string, number>>;
    readonly chatFilterByEpicId: Readonly<Record<string, ChatFilter>>;
    readonly chatArchiveVisibilityByEpicId: Readonly<Record<string, string>>;
    readonly artifactFilterByEpicId: Readonly<Record<string, ArtifactFilter>>;
  };
  readonly version: number;
}

function readPersistedLeftPanelState(): PersistedLeftPanelState {
  const raw = window.localStorage.getItem(PERSIST_KEY) ?? "{}";
  return JSON.parse(raw) as PersistedLeftPanelState;
}

function resetStore(): void {
  window.localStorage.clear();
  resetLayoutStore();
  useSidebarRailWidthStore.setState({ naturalWidthPxByTabId: {} });
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    mainCollapsedByTabId: {},
    sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
    panelSectionCollapsedByPanelId: {},
    panelSectionWeightsByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
    chatFilterByEpicId: {},
    chatArchiveVisibilityByEpicId: {},
    artifactFilterByEpicId: {},
  });
}

describe("useLeftPanelStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("defaults to the chats panel per tab", () => {
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      DEFAULT_LEFT_PANEL_ID,
    );
  });

  it("scopes active panel state per tab", () => {
    useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "comments",
    );
    expect(useLeftPanelStore.getState().getActivePanelId("tab-b")).toBe(
      "chats",
    );
  });

  it("does not share same-epic sidebar state across tabs", () => {
    useLeftPanelStore.getState().setActivePanelId("tab-a", "artifacts");
    useLeftPanelStore.getState().setMainCollapsed("tab-a", true);
    useLeftPanelStore.getState().revealCommentsPanel("tab-a");

    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "artifacts",
    );
    expect(useLeftPanelStore.getState().isMainCollapsed("tab-a")).toBe(true);
    expect(useLeftPanelStore.getState().isCommentsPanelRevealed("tab-a")).toBe(
      true,
    );
    expect(useLeftPanelStore.getState().getActivePanelId("tab-b")).toBe(
      "chats",
    );
    expect(useLeftPanelStore.getState().isMainCollapsed("tab-b")).toBe(false);
    expect(useLeftPanelStore.getState().isCommentsPanelRevealed("tab-b")).toBe(
      false,
    );
  });

  it("copies tab-scoped sidebar chrome to a newly derived tab", () => {
    useLeftPanelStore.getState().setActivePanelId("tab-a", "artifacts");
    useLeftPanelStore.getState().setMainCollapsed("tab-a", true);
    useLeftPanelStore.getState().revealCommentsPanel("tab-a");

    useLeftPanelStore.getState().copyTabState("tab-a", "tab-b");

    expect(useLeftPanelStore.getState().getActivePanelId("tab-b")).toBe(
      "artifacts",
    );
    expect(useLeftPanelStore.getState().isMainCollapsed("tab-b")).toBe(true);
    expect(useLeftPanelStore.getState().isCommentsPanelRevealed("tab-b")).toBe(
      true,
    );
  });

  it("does not persist comments as the active panel", () => {
    useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");

    expect(readPersistedLeftPanelState()).toEqual({
      state: {
        activePanelIdByTabId: {},
        mainCollapsedByTabId: {},
        sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
        // A stack's split and its per-section collapse persist here (L-166);
        // both are empty until the user drags a handle or presses a chevron.
        panelSectionCollapsedByPanelId: {},
        panelSectionWeightsByPanelId: {},
        chatFilterByEpicId: {},
        chatArchiveVisibilityByEpicId: {},
        artifactFilterByEpicId: {},
        chatSortByEpicId: {},
        artifactSortByEpicId: {},
      },
      version: 3,
    });
  });

  it("clamps and persists the global sidebar width", () => {
    useLeftPanelStore.getState().setSidebarWidthPx(431.4);
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(431);
    expect(readPersistedLeftPanelState().state.sidebarWidthPx).toBe(431);

    useLeftPanelStore.getState().setSidebarWidthPx(10);
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      MIN_SIDEBAR_WIDTH_PX,
    );

    useLeftPanelStore.getState().setSidebarWidthPx(10_000);
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      MAX_SIDEBAR_WIDTH_PX,
    );

    useLeftPanelStore.getState().setSidebarWidthPx(Number.NaN);
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      DEFAULT_SIDEBAR_WIDTH_PX,
    );
  });

  // Bug #1: a horizontal rail reports its own unclamped content width
  // (`sidebar-rail-width-store.ts`) as it mounts, so the one global width
  // every tab shares can never land narrower than whichever mounted tab
  // currently needs the most room - the icons used to clip past that point.
  it("widens the floor to match the widest mounted rail's reported width", () => {
    useSidebarRailWidthStore.getState().setRailNaturalWidthPx("tab-a", 260);

    useLeftPanelStore.getState().setSidebarWidthPx(MIN_SIDEBAR_WIDTH_PX);

    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(260);
  });

  it("takes the widest of several mounted tabs' rails, not just the last one reported", () => {
    useSidebarRailWidthStore.getState().setRailNaturalWidthPx("tab-a", 240);
    useSidebarRailWidthStore.getState().setRailNaturalWidthPx("tab-b", 300);

    useLeftPanelStore.getState().setSidebarWidthPx(MIN_SIDEBAR_WIDTH_PX);

    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(300);
  });

  it("never widens past the absolute max width even for a very wide rail", () => {
    useSidebarRailWidthStore.getState().setRailNaturalWidthPx("tab-a", 10_000);

    useLeftPanelStore.getState().setSidebarWidthPx(MIN_SIDEBAR_WIDTH_PX);

    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(
      MAX_SIDEBAR_WIDTH_PX,
    );
  });

  it("still honors a requested width above the dynamic floor", () => {
    useSidebarRailWidthStore.getState().setRailNaturalWidthPx("tab-a", 260);

    useLeftPanelStore.getState().setSidebarWidthPx(400);

    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(400);
  });

  it("restores a collapsed sidebar after refresh", async () => {
    useLeftPanelStore.getState().setMainCollapsed("tab-a", true);

    expect(readPersistedLeftPanelState().state.mainCollapsedByTabId).toEqual({
      "tab-a": true,
    });

    const persistedBeforeRefresh =
      window.localStorage.getItem(PERSIST_KEY) ?? "{}";
    useLeftPanelStore.setState({ mainCollapsedByTabId: {} });
    window.localStorage.setItem(PERSIST_KEY, persistedBeforeRefresh);
    await useLeftPanelStore.persist.rehydrate();

    expect(useLeftPanelStore.getState().isMainCollapsed("tab-a")).toBe(true);

    useLeftPanelStore.getState().setMainCollapsed("tab-a", false);
    expect(readPersistedLeftPanelState().state.mainCollapsedByTabId).toEqual(
      {},
    );
  });

  it("restores a persisted sidebar width", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { sidebarWidthPx: 480 }, version: 1 }),
    );
    await useLeftPanelStore.persist.rehydrate();
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(480);
  });

  it("rehydrates when another window writes the left-panel key", async () => {
    // A legacy-version blob on purpose: the storage listener goes through the
    // same `rehydrate` a start-up hydration does, so `migrate` still runs.
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { sidebarWidthPx: 420 }, version: 1 }),
    );

    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));
    // The listener's rehydrate is fire-and-forget.
    await Promise.resolve();
    await Promise.resolve();

    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(420);
  });

  it("keeps an open Comments panel when another window writes", async () => {
    // The Comments panel is a transient reveal that `partialize` deliberately
    // never persists, so a remote blob CANNOT carry it. Before the merge guard,
    // another window resizing its sidebar replaced the live map with one that
    // by construction had no Comments entry, and the user's open panel became
    // Chats for a reason they could not see.
    useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");
    // The map is in the blob, exactly as the other window wrote it: that window
    // had no Comments panel open, so `partialize` gave it an entry-less map.
    // Omitting the key entirely would let the OLD shallow merge pass too - the
    // local map would survive for want of anything to replace it - so the
    // regression would go unwatched.
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { sidebarWidthPx: 420, activePanelIdByTabId: {} },
        version: 3,
      }),
    );

    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "comments",
    );
    // The remote write still lands - this is a guard on one value, not a veto.
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(420);
  });

  it("takes the remote answer for a durable active panel", async () => {
    // Only `"comments"` is layered back on. Every other panel id round-trips
    // through `partialize`, so keeping the local one would ignore the very
    // write this rehydrate exists to apply.
    useLeftPanelStore.getState().setActivePanelId("tab-a", "artifacts");
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { activePanelIdByTabId: { "tab-a": "terminals" } },
        version: 3,
      }),
    );

    window.dispatchEvent(new StorageEvent("storage", { key: PERSIST_KEY }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "terminals",
    );
  });

  it("persists active chat and artifact filters set through actions", () => {
    act(() => {
      useLeftPanelStore.getState().setChatOrigin("epic-a", "gui");
      useLeftPanelStore.getState().setChatOwnership("epic-a", "others");
      useLeftPanelStore.getState().toggleArtifactStatus("epic-a", 1);
      useLeftPanelStore.getState().toggleArtifactKind("epic-a", "ticket");
      useLeftPanelStore.getState().setArtifactRead("epic-a", "unread");
    });

    const persisted = readPersistedLeftPanelState();
    expect(persisted.state.chatFilterByEpicId).toEqual({
      "epic-a": { origin: "gui", ownership: "others" },
    });
    expect(persisted.state.artifactFilterByEpicId).toEqual({
      "epic-a": { statuses: [1], kinds: ["ticket"], read: "unread" },
    });
  });

  it("restores persisted filters per epic on hydrate", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          chatFilterByEpicId: { "epic-a": { origin: "gui" } },
          artifactFilterByEpicId: {
            "epic-a": { statuses: [1], kinds: ["ticket"], read: "unread" },
          },
        },
        version: 1,
      }),
    );

    await useLeftPanelStore.persist.rehydrate();

    expect(useLeftPanelStore.getState().chatFilterByEpicId["epic-a"]).toEqual({
      origin: "gui",
      ownership: "all",
    });
    expect(
      useLeftPanelStore.getState().artifactFilterByEpicId["epic-a"],
    ).toEqual({ statuses: [1], kinds: ["ticket"], read: "unread" });
  });

  it("does not persist filters that toggle back to inactive", () => {
    act(() => {
      useLeftPanelStore.getState().setChatOrigin("epic-a", "all");
      useLeftPanelStore.getState().toggleArtifactStatus("epic-a", 1);
      useLeftPanelStore.getState().toggleArtifactStatus("epic-a", 1);
    });

    const persisted = readPersistedLeftPanelState();
    expect(persisted.state.chatFilterByEpicId).toEqual({});
    expect(persisted.state.artifactFilterByEpicId).toEqual({});
  });

  it("matches viewer ownership for Mine and Others", () => {
    expect(matchesChatOwnershipFilter(true, CHAT_OWNERSHIP.Mine)).toBe(true);
    expect(matchesChatOwnershipFilter(false, CHAT_OWNERSHIP.Mine)).toBe(false);
    expect(matchesChatOwnershipFilter(true, CHAT_OWNERSHIP.Others)).toBe(false);
    expect(matchesChatOwnershipFilter(false, CHAT_OWNERSHIP.Others)).toBe(true);
  });

  it("defaults archive visibility to unarchived only", () => {
    const { result } = renderHook(() => useChatArchiveVisibility("epic-a"));
    expect(result.current).toBe(CHAT_ARCHIVE_VISIBILITY.Unarchived);
  });

  it("persists non-default archive visibility and drops the default", () => {
    act(() => {
      useLeftPanelStore
        .getState()
        .setChatArchiveVisibility("epic-a", CHAT_ARCHIVE_VISIBILITY.Archived);
    });
    expect(
      readPersistedLeftPanelState().state.chatArchiveVisibilityByEpicId,
    ).toEqual({ "epic-a": "archived" });

    act(() => {
      useLeftPanelStore
        .getState()
        .setChatArchiveVisibility("epic-a", CHAT_ARCHIVE_VISIBILITY.All);
    });
    expect(
      readPersistedLeftPanelState().state.chatArchiveVisibilityByEpicId,
    ).toEqual({ "epic-a": "all" });

    act(() => {
      useLeftPanelStore
        .getState()
        .setChatArchiveVisibility("epic-a", CHAT_ARCHIVE_VISIBILITY.Unarchived);
    });
    expect(
      readPersistedLeftPanelState().state.chatArchiveVisibilityByEpicId,
    ).toEqual({});
  });

  it('migrates legacy "Show archived" preferences to All chats', async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          chatShowArchivedByEpicId: {
            "epic-all": true,
            "epic-default": false,
          },
        },
        version: 1,
      }),
    );

    await useLeftPanelStore.persist.rehydrate();

    expect(useLeftPanelStore.getState().chatArchiveVisibilityByEpicId).toEqual({
      "epic-all": "all",
    });
  });

  it("keeps rail order global instead of scoping layout by tab", () => {
    movePanelBeside("artifacts", "chats", false);
    useLeftPanelStore.getState().setActivePanelId("tab-a", "artifacts");
    useLeftPanelStore.getState().setActivePanelId("tab-b", "file-tree");

    expect(railPanelIds(currentRail())).toEqual([
      "artifacts",
      "chats",
      "files",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "artifacts",
    );
    expect(useLeftPanelStore.getState().getActivePanelId("tab-b")).toBe(
      "file-tree",
    );
  });

  it("applyRail writes nothing for a structurally equal rail", () => {
    // Identity is asserted on the RAIL itself: `useLayoutRail()` builds its
    // view straight off `arrangement.rail`, while the below memoizes on
    // exactly this array reference.
    const before = useLayoutStore.getState().arrangement.rail;

    applyRail(DEFAULT_RAIL.map((entry) => ({ ...entry })));

    expect(useLayoutStore.getState().arrangement.rail).toBe(before);
  });

  it("normalizes duplicate and missing panel ids written through the rail", () => {
    applyRail([
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railComments" },
    ]);

    // `setArrangement` runs every write through `normalizeRail`: a duplicate
    // is dropped, and a panel this list left out comes back beside its
    // canonical neighbour rather than appended at the end. Nothing in the app
    // can send an incomplete list - every writer derives its rail from the
    // one already in the store - but a persisted blob from an older build can.
    expect(railPanelIds(currentRail())).toEqual([
      "chats",
      "artifacts",
      "files",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
  });

  it("writes nothing on a no-op rail move", () => {
    movePanelBeside("artifacts", "chats", false);
    const before = useLayoutStore.getState().arrangement.rail;
    movePanelBeside("artifacts", "chats", false);
    expect(useLayoutStore.getState().arrangement.rail).toBe(before);
  });

  it("keeps the rail hook snapshot stable across unrelated writes", () => {
    movePanelBeside("artifacts", "chats", false);
    const hook = renderHook(() => useLayoutRail());
    const before = hook.result.current;

    act(() => {
      useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");
    });

    expect(hook.result.current).toBe(before);
  });

  it("setActivePanelIdAndExpand expands a collapsed main panel", () => {
    useLeftPanelStore.getState().setMainCollapsed("tab-a", true);
    useLeftPanelStore.getState().setActivePanelIdAndExpand("tab-a", "comments");
    expect(useLeftPanelStore.getState().isMainCollapsed("tab-a")).toBe(false);
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "comments",
    );
  });

  it("reveals comments panel state per tab", () => {
    expect(useLeftPanelStore.getState().isCommentsPanelRevealed("tab-a")).toBe(
      false,
    );
    useLeftPanelStore.getState().revealCommentsPanel("tab-a");
    expect(useLeftPanelStore.getState().isCommentsPanelRevealed("tab-a")).toBe(
      true,
    );
    expect(useLeftPanelStore.getState().isCommentsPanelRevealed("tab-b")).toBe(
      false,
    );
  });

  it("keeps slice identity on no-op active panel writes", () => {
    useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");
    const before = useLeftPanelStore.getState().activePanelIdByTabId;
    useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");
    expect(useLeftPanelStore.getState().activePanelIdByTabId).toBe(before);
  });

  it("sets and clears local root-create pending by epic and panel", () => {
    useLeftPanelStore
      .getState()
      .setLocalRootCreatePending("epic-a", "chats", "New chat");
    expect(
      useLeftPanelStore.getState().getLocalRootCreatePending("epic-a", "chats"),
    ).toEqual({ name: "New chat" });
    expect(
      useLeftPanelStore
        .getState()
        .getLocalRootCreatePending("epic-a", "artifacts"),
    ).toBeNull();

    useLeftPanelStore.getState().clearLocalRootCreatePending("epic-a", "chats");
    expect(
      useLeftPanelStore.getState().getLocalRootCreatePending("epic-a", "chats"),
    ).toBeNull();
  });

  it("sets and clears acknowledged root-create pending by epic and panel", () => {
    useLeftPanelStore
      .getState()
      .setAcknowledgedRootCreatePending(
        "epic-a",
        "artifacts",
        "artifact-1",
        "New spec",
      );
    expect(
      useLeftPanelStore
        .getState()
        .getAcknowledgedRootCreatePending("epic-a", "artifacts"),
    ).toEqual({ id: "artifact-1", name: "New spec" });
    expect(
      useLeftPanelStore
        .getState()
        .getAcknowledgedRootCreatePending("epic-b", "artifacts"),
    ).toBeNull();

    useLeftPanelStore
      .getState()
      .clearAcknowledgedRootCreatePending("epic-a", "artifacts");
    expect(
      useLeftPanelStore
        .getState()
        .getAcknowledgedRootCreatePending("epic-a", "artifacts"),
    ).toBeNull();
  });

  it("persists panel visibility overrides so they survive a reload", () => {
    expect(visibilityOverrides()).toEqual({});

    setRailVisibilityOverride("pull-requests", true);
    setRailVisibilityOverride("sharing", false);

    expect(visibilityOverrides()).toEqual({
      "pull-requests": true,
      sharing: false,
    });
    expect(readPersistedLayoutOverrides()).toEqual({
      railPullRequests: { shown: "shown" },
      railSharing: { shown: "hidden" },
    });
  });

  it("takes the pick OUT of the delta when a panel goes back on its own rule", () => {
    // `null` is how the menu says "this matches the panel's own rule again".
    // It is the absence of a pick, not a pick of Automatic, so it REMOVES the
    // answer rather than recording one (L-133, L-150(3)).
    //
    // What that buys is the day a preset sets a rail region to `shown` or
    // `hidden`: a recorded `auto` would be a real pick pinning the panel
    // against that preset, and "Reset panel visibility" would write nine of
    // them for a user who had overridden one.
    setRailVisibilityOverride("pull-requests", true);
    setRailVisibilityOverride("chats", false);
    setRailVisibilityOverride("pull-requests", null);
    setRailVisibilityOverride("chats", null);

    expect(visibilityOverrides()).toEqual({});
    expect(readPersistedLayoutOverrides()).toEqual({});
  });

  it("refuses to activate a panel the user explicitly hid", () => {
    // `collab-tile-body` / `start-comment-draft` switch the sidebar to Comments
    // on the user's behalf. If Comments is switched off, that must be a no-op
    // rather than pointing the sidebar at a panel with no rail icon.
    setRailVisibilityOverride("comments", false);
    useLeftPanelStore.getState().setMainCollapsed("tab-a", true);

    useLeftPanelStore.getState().setActivePanelIdAndExpand("tab-a", "comments");

    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "chats",
    );
    expect(useLeftPanelStore.getState().isMainCollapsed("tab-a")).toBe(true);
  });

  it("still activates a panel that is merely absent, not disabled", () => {
    // Absence is not a user decision: the reveal path turns Comments on in the
    // same turn, so the switch has to land.
    useLeftPanelStore.getState().revealCommentsPanel("tab-a");
    useLeftPanelStore.getState().setActivePanelIdAndExpand("tab-a", "comments");

    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "comments",
    );
  });

  it("keeps slice identity when an override is set to its current value", () => {
    const before = useLeftPanelStore.getState();
    setRailVisibilityOverride("chats", null);
    expect(useLeftPanelStore.getState()).toBe(before);

    setRailVisibilityOverride("chats", false);
    const afterHide = useLeftPanelStore.getState();
    setRailVisibilityOverride("chats", false);
    expect(useLeftPanelStore.getState()).toBe(afterHide);

    setRailVisibilityOverride("chats", null);
    const cleared = useLeftPanelStore.getState();
    setRailVisibilityOverride("chats", null);
    expect(useLeftPanelStore.getState()).toBe(cleared);
  });
});

describe("a stacked pair's split and collapse (L-166)", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("persists a collapsed section and drops it again when it expands", () => {
    useLeftPanelStore.getState().togglePanelSectionCollapsed("artifacts");

    expect(
      readPersistedLeftPanelState().state.panelSectionCollapsedByPanelId,
    ).toEqual({ artifacts: true });

    useLeftPanelStore.getState().togglePanelSectionCollapsed("artifacts");

    // Only the collapsed ones are written: an expanded section is the absence
    // of a record rather than a `false` in every user's blob.
    expect(
      readPersistedLeftPanelState().state.panelSectionCollapsedByPanelId,
    ).toEqual({});
  });

  it("clears a section's collapse when that panel is focused", () => {
    useLeftPanelStore.getState().togglePanelSectionCollapsed("artifacts");
    useLeftPanelStore
      .getState()
      .setActivePanelIdAndExpand("tab-a", "artifacts");

    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.artifacts,
    ).toBe(false);
  });

  it("persists the split the user dragged the handle to", () => {
    useLeftPanelStore.getState().setPanelSectionWeights([
      { panelId: "chats", weight: 33.333 },
      { panelId: "artifacts", weight: 66.667 },
    ]);

    expect(
      readPersistedLeftPanelState().state.panelSectionWeightsByPanelId,
    ).toEqual({ chats: 33.33, artifacts: 66.67 });
  });
});
