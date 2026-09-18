import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
} from "@traycer/protocol/host/worktree-schemas";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useTuiSetupTerminalTabRegisterDriver } from "@/hooks/agent/use-tui-setup-terminal-tab-register-driver";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import { useSetupTerminalsStore } from "@/stores/worktree/setup-terminals";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes, type TilePane } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const EPIC_ID = "epic-tui-setup-title";
const AGENT_ID = "tui-agent-setup-title";
const HOST_ID = "host-tui-setup-title";

const WORKTREE_ENTRY: WorktreeBindingEntry = {
  workspacePath: "/Users/me/projects/traycer",
  mode: "worktree",
  repoIdentifier: { owner: "traycerai", repo: "traycer" },
  worktreePath: "/Users/me/.traycer/worktrees/traycerai__traycer/feature",
  branch: "feature/setup-title",
  isPrimary: true,
  isImported: false,
  setupState: "running",
  setupTerminalSessionId: "setup-terminal-session",
  setupExitCode: null,
  setupFailedAt: null,
  createdAt: 1,
  ownedSubmodules: [],
};

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return <TabHostProvider hostId={HOST_ID}>{props.children}</TabHostProvider>;
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useSetupTerminalRegistrationStore.getState().reset();
  useSetupTerminalsStore.setState(
    useSetupTerminalsStore.getInitialState(),
    true,
  );
}

/** The view's globally-active pane id, or a hard failure - test-only. */
function activePaneIdOrThrow(viewTabId: string): string {
  const paneId =
    useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.activePaneId ??
    null;
  if (paneId === null) throw new Error("expected an active pane");
  return paneId;
}

/** Look up one pane of the view's canvas by id, or a hard failure. */
function paneOrThrow(viewTabId: string, paneId: string): TilePane {
  const root =
    useEpicCanvasStore.getState().canvasByTabId[viewTabId]?.root ?? null;
  const pane = collectPanes(root).find((candidate) => candidate.id === paneId);
  if (pane === undefined) throw new Error(`expected pane ${paneId}`);
  return pane;
}

/** `pane`'s tab payloads, in strip order - test-only wrapper over `paneTabRefs`. */
function tabsOf(
  viewTabId: string,
  pane: TilePane,
): ReadonlyArray<EpicCanvasTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected a live canvas");
  return paneTabRefs(canvas, pane);
}

/** Whether the auto-opened setup terminal tab is present anywhere in the view. */
function hasTerminalTab(viewTabId: string): boolean {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined || canvas.root === null) return false;
  return collectPanes(canvas.root)
    .flatMap((pane) => paneTabRefs(canvas, pane))
    .some((tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId);
}

describe("useTuiSetupTerminalTabRegisterDriver", () => {
  afterEach(() => {
    resetStores();
  });

  it("uses the setup title for the registered background terminal tab", () => {
    resetStores();
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic");
    useEpicCanvasStore.getState().openTileInTab(viewTabId, {
      id: AGENT_ID,
      instanceId: "tui-agent-instance",
      type: "terminal-agent",
      name: "Terminal agent",
      hostId: HOST_ID,
    });

    const binding: WorktreeBinding = { entries: [WORKTREE_ENTRY] };
    renderHook(
      () =>
        useTuiSetupTerminalTabRegisterDriver({
          binding,
          viewTabId,
          owningTileInstanceId: "tui-agent-instance",
        }),
      { wrapper: Wrapper },
    );

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    expect(canvas?.root).not.toBeNull();
    if (canvas === undefined || canvas.root === null) return;
    const tiles = collectPanes(canvas.root).flatMap((pane) =>
      paneTabRefs(canvas, pane),
    );
    const setupTile = tiles.find(
      (tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId,
    );
    expect(setupTile).toMatchObject({
      id: WORKTREE_ENTRY.setupTerminalSessionId,
      type: "terminal",
      name: "Setup: traycer feature/setup-title",
      titleSource: "manual",
      hostId: HOST_ID,
      cwd: WORKTREE_ENTRY.worktreePath,
      origin: "setup",
    });
    // `instanceId` is a freshly minted per-tab-instance id (NOT the session
    // id - reusing it would alias stream handles across views).
    expect(typeof setupTile?.instanceId).toBe("string");
    expect(setupTile?.instanceId).not.toBe(
      WORKTREE_ENTRY.setupTerminalSessionId,
    );

    // Cross-view uniqueness: the SAME session registered in a second view
    // must mint its own instance id, or the two views alias one
    // session-registry stream handle.
    const secondViewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic 2");
    useEpicCanvasStore.getState().openTileInTab(secondViewTabId, {
      id: AGENT_ID,
      instanceId: "tui-agent-instance-2",
      type: "terminal-agent",
      name: "Terminal agent",
      hostId: HOST_ID,
    });
    renderHook(
      () =>
        useTuiSetupTerminalTabRegisterDriver({
          binding,
          viewTabId: secondViewTabId,
          owningTileInstanceId: "tui-agent-instance-2",
        }),
      { wrapper: Wrapper },
    );
    const secondCanvas =
      useEpicCanvasStore.getState().canvasByTabId[secondViewTabId];
    expect(secondCanvas?.root).not.toBeNull();
    if (secondCanvas === undefined || secondCanvas.root === null) return;
    const secondSetupTile = collectPanes(secondCanvas.root)
      .flatMap((pane) => paneTabRefs(secondCanvas, pane))
      .find((tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId);
    expect(typeof secondSetupTile?.instanceId).toBe("string");
    expect(secondSetupTile?.instanceId).not.toBe(setupTile?.instanceId);
  });

  it("registers a background terminal tab for every running setup entry", () => {
    resetStores();
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic");
    useEpicCanvasStore.getState().openTileInTab(viewTabId, {
      id: AGENT_ID,
      instanceId: "tui-agent-instance",
      type: "terminal-agent",
      name: "Terminal agent",
      hostId: HOST_ID,
    });

    const apiEntry: WorktreeBindingEntry = {
      ...WORKTREE_ENTRY,
      workspacePath: "/Users/me/projects/api",
      worktreePath: "/Users/me/.traycer/worktrees/acme__api/feature-api",
      branch: "feature-api",
      isPrimary: false,
      setupTerminalSessionId: "setup-api",
    };
    const webEntry: WorktreeBindingEntry = {
      ...WORKTREE_ENTRY,
      workspacePath: "/Users/me/projects/web",
      worktreePath: "/Users/me/.traycer/worktrees/acme__web/feature-web",
      branch: "feature-web",
      isPrimary: false,
      setupTerminalSessionId: "setup-web",
    };

    const binding: WorktreeBinding = {
      entries: [WORKTREE_ENTRY, apiEntry, webEntry],
    };
    renderHook(
      () =>
        useTuiSetupTerminalTabRegisterDriver({
          binding,
          viewTabId,
          owningTileInstanceId: "tui-agent-instance",
        }),
      { wrapper: Wrapper },
    );

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    expect(canvas).toBeDefined();
    if (canvas === undefined) {
      throw new Error("Expected epic canvas to exist");
    }
    expect(canvas.root).not.toBeNull();
    if (canvas.root === null) {
      throw new Error("Expected epic canvas root to exist");
    }
    const terminalIds = collectPanes(canvas.root)
      .flatMap((pane) => paneTabRefs(canvas, pane))
      .filter((tile) => tile.type === "terminal")
      .map((tile) => tile.id)
      .sort();
    expect(terminalIds).toEqual([
      "setup-api",
      "setup-terminal-session",
      "setup-web",
    ]);
  });

  it("places the background terminal in the owning agent's pane, not the active pane, and never reopens it once closed", () => {
    resetStores();
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic");

    // Pane B: the owning terminal-agent's pane - the only (so active) root
    // pane first.
    useEpicCanvasStore.getState().openTileInTab(viewTabId, {
      id: AGENT_ID,
      instanceId: "tui-agent-instance",
      type: "terminal-agent",
      name: "Terminal agent",
      hostId: HOST_ID,
    });
    const paneB = activePaneIdOrThrow(viewTabId);

    // Pane A: split off an UNRELATED terminal-agent (also "conversation"
    // category, so the old affinity fallback - "the active pane already
    // hosting a conversation tile wins outright" - would misplace the setup
    // terminal here instead of the owner's pane). The new pane becomes active.
    useEpicCanvasStore.getState().splitPaneWithNode(viewTabId, paneB, "right", {
      id: "unrelated-tui-agent",
      instanceId: "unrelated-tui-agent-instance",
      type: "terminal-agent",
      name: "Unrelated terminal agent",
      hostId: HOST_ID,
    });
    const paneA = activePaneIdOrThrow(viewTabId);
    expect(paneA).not.toBe(paneB);

    const binding: WorktreeBinding = { entries: [WORKTREE_ENTRY] };
    const { rerender } = renderHook(
      (props: { readonly binding: WorktreeBinding }) =>
        useTuiSetupTerminalTabRegisterDriver({
          binding: props.binding,
          viewTabId,
          owningTileInstanceId: "tui-agent-instance",
        }),
      { wrapper: Wrapper, initialProps: { binding } },
    );

    const ownerPane = paneOrThrow(viewTabId, paneB);
    const activePane = paneOrThrow(viewTabId, paneA);
    const terminalRef = tabsOf(viewTabId, ownerPane).find(
      (tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId,
    );

    // The terminal lands as a tab of the OWNER's pane (B), never the
    // unrelated active pane (A), and focus is left exactly where it was -
    // pane A is still globally active and its own active tab is unchanged,
    // exactly as a background (host-pushed) open must leave it.
    expect(terminalRef).toBeDefined();
    expect(
      tabsOf(viewTabId, activePane).some(
        (tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId,
      ),
    ).toBe(false);
    expect(activePaneIdOrThrow(viewTabId)).toBe(paneA);
    expect(activePane.activeTabId).toBe("unrelated-tui-agent-instance");
    if (terminalRef === undefined) throw new Error("expected a terminal tab");

    // The user closes the auto-opened setup terminal tab.
    useEpicCanvasStore
      .getState()
      .closeCanvasTab(viewTabId, paneB, terminalRef.instanceId);
    expect(hasTerminalTab(viewTabId)).toBe(false);

    // Binding churn (a fresh object identity, still running), delivered as a
    // remount via a prop update - the polled-binding driver's equivalent of
    // a re-render - must not reopen the closed tab.
    rerender({ binding: { entries: [{ ...WORKTREE_ENTRY }] } });
    expect(hasTerminalTab(viewTabId)).toBe(false);
  });
});
