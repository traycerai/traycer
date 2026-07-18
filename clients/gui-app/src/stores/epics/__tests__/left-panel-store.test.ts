import "../../../../__tests__/test-browser-apis";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  DEFAULT_LEFT_PANEL_ID,
  DEFAULT_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  moveLeftPanelGroup,
  moveLeftPanelGroupToPanelPosition,
  moveLeftPanelToEnd,
  moveLeftPanelToGroup,
  moveLeftPanelToGroupPosition,
  moveLeftPanelToPanelPosition,
  useLeftPanelGroups,
  useLeftPanelStore,
  type ArtifactFilter,
  type ChatFilter,
  type LeftPanelGroup,
  type LeftPanelId,
} from "../left-panel-store";

const PERSIST_KEY = "traycer-gui-app:left-panel";

/**
 * Apply a group move through the public pipeline (the DnD commit path):
 * resolve the next groups with the pure `moveLeftPanelGroup` helper, then
 * commit them atomically via `applyPanelGroups`.
 */
function applyPanelGroupMove(
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  position: "before" | "after" | "combine",
): void {
  const store = useLeftPanelStore.getState();
  store.applyPanelGroups(
    moveLeftPanelGroup(
      store.getPanelGroups(),
      sourcePanelId,
      targetPanelId,
      position,
    ),
  );
}

interface PersistedLeftPanelState {
  readonly state: {
    readonly activePanelIdByTabId: Readonly<Record<string, string>>;
    readonly panelGroups: ReadonlyArray<LeftPanelGroup>;
    readonly sidebarWidthPx: number;
    readonly panelSectionCollapsedByPanelId: Readonly<Record<string, boolean>>;
    readonly panelSectionWeightsByPanelId: Readonly<Record<string, number>>;
    readonly chatFilterByEpicId: Readonly<Record<string, ChatFilter>>;
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
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
    panelSectionCollapsedByPanelId: {},
    panelSectionWeightsByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
    chatFilterByEpicId: {},
    artifactFilterByEpicId: {},
  });
}

const SPLIT_PANEL_GROUPS: ReadonlyArray<LeftPanelGroup> = [
  { panelIds: ["chats"] },
  { panelIds: ["artifacts"] },
  { panelIds: ["terminals"] },
  { panelIds: ["git-diff"] },
  { panelIds: ["pull-requests"] },
  { panelIds: ["file-tree"] },
  { panelIds: ["sharing"] },
  { panelIds: ["comments"] },
];

function splitChatsAndArtifacts(): void {
  useLeftPanelStore.setState({ panelGroups: SPLIT_PANEL_GROUPS });
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

  it("defaults panel groups with chats and artifacts combined", () => {
    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("normalizes bad persisted groups on access via getPanelGroups", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          activePanelIdByTabId: {},
          panelGroups: null,
        },
        version: 1,
      }),
    );

    await useLeftPanelStore.persist.rehydrate();

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
  });

  it("normalizes malformed persisted panel groups on access", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          activePanelIdByTabId: {
            "tab-a": "artifacts",
          },
          panelGroups: [{ panelIds: ["chats", "not-a-panel"] }],
        },
        version: 1,
      }),
    );

    await useLeftPanelStore.persist.rehydrate();

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual(
      DEFAULT_LEFT_PANEL_GROUPS,
    );
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "artifacts",
    );
  });

  it("hydrates valid global section collapse state", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          panelSectionCollapsedByPanelId: {
            artifacts: true,
          },
        },
        version: 1,
      }),
    );

    await useLeftPanelStore.persist.rehydrate();

    expect(
      useLeftPanelStore.getState().isPanelSectionCollapsed("artifacts"),
    ).toBe(true);
    expect(useLeftPanelStore.getState().isPanelSectionCollapsed("chats")).toBe(
      false,
    );
  });

  it("does not persist comments as the active panel", () => {
    useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");

    expect(readPersistedLeftPanelState()).toEqual({
      state: {
        activePanelIdByTabId: {},
        panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
        sidebarWidthPx: DEFAULT_SIDEBAR_WIDTH_PX,
        panelSectionCollapsedByPanelId: {},
        panelSectionWeightsByPanelId: {},
        chatFilterByEpicId: {},
        artifactFilterByEpicId: {},
        chatSortByEpicId: {},
        artifactSortByEpicId: {},
      },
      version: 1,
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

  it("restores a persisted sidebar width", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ state: { sidebarWidthPx: 480 }, version: 1 }),
    );
    await useLeftPanelStore.persist.rehydrate();
    expect(useLeftPanelStore.getState().sidebarWidthPx).toBe(480);
  });

  it("persists active chat and artifact filters set through actions", () => {
    act(() => {
      useLeftPanelStore.getState().setChatOrigin("epic-a", "gui");
      useLeftPanelStore.getState().toggleArtifactStatus("epic-a", 1);
      useLeftPanelStore.getState().toggleArtifactKind("epic-a", "ticket");
      useLeftPanelStore.getState().setArtifactRead("epic-a", "unread");
    });

    const persisted = readPersistedLeftPanelState();
    expect(persisted.state.chatFilterByEpicId).toEqual({
      "epic-a": { origin: "gui" },
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

  it("reorders panel groups before or after another group", () => {
    splitChatsAndArtifacts();
    applyPanelGroupMove("artifacts", "chats", "before");
    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["artifacts"] },
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);

    applyPanelGroupMove("comments", "chats", "after");
    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["artifacts"] },
      { panelIds: ["chats"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("combines two panel groups into one group", () => {
    splitChatsAndArtifacts();
    applyPanelGroupMove("artifacts", "chats", "combine");
    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("keeps panel groups global instead of scoping layout by tab", () => {
    splitChatsAndArtifacts();
    applyPanelGroupMove("artifacts", "chats", "combine");
    useLeftPanelStore.getState().setActivePanelId("tab-a", "artifacts");
    useLeftPanelStore.getState().setActivePanelId("tab-b", "file-tree");

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "artifacts",
    );
    expect(useLeftPanelStore.getState().getActivePanelId("tab-b")).toBe(
      "file-tree",
    );
  });

  it("inserts a rail group at a panel section position inside another group", () => {
    expect(
      moveLeftPanelGroupToPanelPosition(
        [
          { panelIds: ["chats", "artifacts"] },
          { panelIds: ["git-diff"] },
          { panelIds: ["pull-requests"] },
          { panelIds: ["file-tree"] },
          { panelIds: ["comments"] },
        ],
        "file-tree",
        "artifacts",
        "before",
      ),
    ).toEqual([
      { panelIds: ["chats", "file-tree", "artifacts"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("inserts one panel at a panel section position inside another group", () => {
    expect(
      moveLeftPanelToPanelPosition(
        [
          { panelIds: ["chats", "artifacts"] },
          { panelIds: ["git-diff"] },
          { panelIds: ["pull-requests"] },
          { panelIds: ["file-tree"] },
          { panelIds: ["comments"] },
        ],
        "git-diff",
        "artifacts",
        "after",
      ),
    ).toEqual([
      { panelIds: ["chats", "artifacts", "git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("reorders one panel within a combined group using section positions", () => {
    expect(
      moveLeftPanelToPanelPosition(
        [{ panelIds: ["chats", "artifacts"] }, { panelIds: ["comments"] }],
        "artifacts",
        "chats",
        "before",
      ),
    ).toEqual([
      { panelIds: ["artifacts", "chats"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("extracts one panel from a combined group before or after another group", () => {
    applyPanelGroupMove("artifacts", "chats", "combine");
    const store = useLeftPanelStore.getState();
    store.applyPanelGroups(
      moveLeftPanelToGroupPosition(
        store.getPanelGroups(),
        "artifacts",
        "comments",
        "before",
      ),
    );
    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("applyPanelGroups keeps slice identity for structurally equal groups", () => {
    const before = useLeftPanelStore.getState().panelGroups;

    useLeftPanelStore.getState().applyPanelGroups(
      DEFAULT_LEFT_PANEL_GROUPS.map((group) => ({
        panelIds: [...group.panelIds],
      })),
    );

    expect(useLeftPanelStore.getState().panelGroups).toBe(before);
  });

  it("applyPanelGroups normalizes duplicate and missing panel ids", () => {
    useLeftPanelStore
      .getState()
      .applyPanelGroups([
        { panelIds: ["chats", "chats"] },
        { panelIds: ["comments"] },
      ]);

    expect(useLeftPanelStore.getState().getPanelGroups()).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("reorders panels within a combined group", () => {
    expect(
      moveLeftPanelToPanelPosition(
        [{ panelIds: ["artifacts", "chats"] }, { panelIds: ["comments"] }],
        "chats",
        "artifacts",
        "before",
      ),
    ).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("extracts one panel from a combined group to the rail end", () => {
    expect(
      moveLeftPanelToEnd(
        [{ panelIds: ["chats", "artifacts"] }, { panelIds: ["comments"] }],
        "chats",
      ),
    ).toEqual([
      { panelIds: ["artifacts"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["chats"] },
    ]);
  });

  it("extracts one panel from a combined group around that group's rail icon", () => {
    expect(
      moveLeftPanelToGroupPosition(
        [{ panelIds: ["artifacts", "chats"] }, { panelIds: ["comments"] }],
        "artifacts",
        "artifacts",
        "after",
      ),
    ).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
    expect(
      moveLeftPanelToGroupPosition(
        [{ panelIds: ["artifacts", "chats"] }, { panelIds: ["comments"] }],
        "chats",
        "artifacts",
        "before",
      ),
    ).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["comments"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("combines one panel from a grouped source with another target group", () => {
    expect(
      moveLeftPanelToGroup(
        [{ panelIds: ["chats", "artifacts"] }, { panelIds: ["comments"] }],
        "artifacts",
        "comments",
      ),
    ).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["comments", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("keeps slice identity on no-op panel group moves", () => {
    applyPanelGroupMove("artifacts", "chats", "combine");
    const before = useLeftPanelStore.getState().panelGroups;
    applyPanelGroupMove("artifacts", "chats", "combine");
    expect(useLeftPanelStore.getState().panelGroups).toBe(before);
  });

  it("keeps the panel groups hook snapshot stable across unrelated writes", () => {
    applyPanelGroupMove("artifacts", "chats", "combine");
    const hook = renderHook(() => useLeftPanelGroups());
    const before = hook.result.current;

    act(() => {
      useLeftPanelStore.getState().setActivePanelId("tab-a", "comments");
    });

    expect(hook.result.current).toBe(before);
  });

  it("normalizes duplicate or missing panel ids in stored groups", () => {
    expect(
      moveLeftPanelGroup(
        [{ panelIds: ["chats", "chats"] }, { panelIds: ["comments"] }],
        "comments",
        "chats",
        "before",
      ),
    ).toEqual([
      { panelIds: ["comments"] },
      { panelIds: ["chats"] },
      { panelIds: ["terminals"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("setActivePanelIdAndExpand expands a collapsed main panel", () => {
    useLeftPanelStore.getState().setMainCollapsed("tab-a", true);
    useLeftPanelStore.getState().setActivePanelIdAndExpand("tab-a", "comments");
    expect(useLeftPanelStore.getState().isMainCollapsed("tab-a")).toBe(false);
    expect(useLeftPanelStore.getState().getActivePanelId("tab-a")).toBe(
      "comments",
    );
  });

  it("setActivePanelIdAndExpand expands a collapsed grouped panel section", () => {
    useLeftPanelStore.getState().setPanelSectionCollapsed("comments", true);

    useLeftPanelStore.getState().setActivePanelIdAndExpand("tab-a", "comments");

    expect(
      useLeftPanelStore.getState().isPanelSectionCollapsed("comments"),
    ).toBe(false);
  });

  it("tracks grouped panel section collapse state globally by panel", () => {
    expect(
      useLeftPanelStore.getState().isPanelSectionCollapsed("artifacts"),
    ).toBe(false);

    useLeftPanelStore.getState().setPanelSectionCollapsed("artifacts", true);

    expect(
      useLeftPanelStore.getState().isPanelSectionCollapsed("artifacts"),
    ).toBe(true);
    expect(useLeftPanelStore.getState().isPanelSectionCollapsed("chats")).toBe(
      false,
    );
  });

  it("keeps slice identity on no-op grouped panel section collapse writes", () => {
    useLeftPanelStore.getState().setPanelSectionCollapsed("artifacts", true);
    const before = useLeftPanelStore.getState().panelSectionCollapsedByPanelId;

    useLeftPanelStore.getState().setPanelSectionCollapsed("artifacts", true);

    expect(useLeftPanelStore.getState().panelSectionCollapsedByPanelId).toBe(
      before,
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
});
