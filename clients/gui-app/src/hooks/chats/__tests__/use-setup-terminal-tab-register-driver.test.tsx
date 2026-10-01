import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeBindingEntry } from "@traycer/protocol/host";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useSetupTerminalTabRegisterDriver } from "@/hooks/chats/use-setup-terminal-tab-register-driver";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import {
  isSetupTerminal,
  useSetupTerminalsStore,
} from "@/stores/worktree/setup-terminals";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes, type TilePane } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-setup-title";
const CHAT_ID = "chat-setup-title";
const USER_ID = "user-setup-title";
const HOST_ID = "host-setup-title";

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

function createHandle() {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, _callbacks) => {
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
}

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

describe("useSetupTerminalTabRegisterDriver", () => {
  afterEach(() => {
    resetStores();
  });

  it("uses the setup title for the registered background terminal tab", () => {
    resetStores();
    const handle = createHandle();
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic");
    useEpicCanvasStore.getState().openTileInTab(viewTabId, {
      id: CHAT_ID,
      instanceId: "chat-instance",
      type: "chat",
      name: "Chat",
      hostId: HOST_ID,
    });

    act(() => {
      handle.store.setState({
        worktreeBinding: { entries: [WORKTREE_ENTRY] },
      });
    });

    renderHook(
      () =>
        useSetupTerminalTabRegisterDriver({
          handle,
          viewTabId,
          owningTileInstanceId: "chat-instance",
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
    expect(
      isSetupTerminal(HOST_ID, WORKTREE_ENTRY.setupTerminalSessionId ?? ""),
    ).toBe(true);
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
      id: CHAT_ID,
      instanceId: "chat-instance-2",
      type: "chat",
      name: "Chat",
      hostId: HOST_ID,
    });
    renderHook(
      () =>
        useSetupTerminalTabRegisterDriver({
          handle,
          viewTabId: secondViewTabId,
          owningTileInstanceId: "chat-instance-2",
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
    const handle = createHandle();
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic");
    useEpicCanvasStore.getState().openTileInTab(viewTabId, {
      id: CHAT_ID,
      instanceId: "chat-instance",
      type: "chat",
      name: "Chat",
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

    act(() => {
      handle.store.setState({
        worktreeBinding: { entries: [WORKTREE_ENTRY, apiEntry, webEntry] },
      });
    });

    renderHook(
      () =>
        useSetupTerminalTabRegisterDriver({
          handle,
          viewTabId,
          owningTileInstanceId: "chat-instance",
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

  it("places the background terminal in the owning chat's pane, not the active pane, and never reopens it once closed", () => {
    resetStores();
    const handle = createHandle();
    const viewTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Epic");

    // Pane B: the owning chat's pane - the only (so active) root pane first.
    useEpicCanvasStore.getState().openTileInTab(viewTabId, {
      id: CHAT_ID,
      instanceId: "chat-instance",
      type: "chat",
      name: "Chat",
      hostId: HOST_ID,
    });
    const paneB = activePaneIdOrThrow(viewTabId);

    // Pane A: split off an UNRELATED chat (also "conversation" category, so
    // the old affinity fallback - "the active pane already hosting a
    // conversation tile wins outright" - would misplace the setup terminal
    // here instead of the owner's pane). The new pane becomes active.
    useEpicCanvasStore.getState().splitPaneWithNode(viewTabId, paneB, "right", {
      id: "unrelated-chat",
      instanceId: "unrelated-chat-instance",
      type: "chat",
      name: "Unrelated chat",
      hostId: HOST_ID,
    });
    const paneA = activePaneIdOrThrow(viewTabId);
    expect(paneA).not.toBe(paneB);

    act(() => {
      handle.store.setState({
        worktreeBinding: { entries: [WORKTREE_ENTRY] },
      });
    });

    const { rerender } = renderHook(
      () =>
        useSetupTerminalTabRegisterDriver({
          handle,
          viewTabId,
          owningTileInstanceId: "chat-instance",
        }),
      { wrapper: Wrapper },
    );

    const ownerPane = paneOrThrow(viewTabId, paneB);
    const activePane = paneOrThrow(viewTabId, paneA);
    const terminalRef = tabsOf(viewTabId, ownerPane).find(
      (tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId,
    );

    // The terminal lands as a tab of the OWNER's pane (B), never the
    // unrelated active pane (A), and focus is left exactly where it was -
    // pane A is still globally active and its own active tab is unchanged,
    // and pane B's own active tab is STILL the owning chat, not the newly
    // inserted background terminal - exactly as a background (host-pushed)
    // open must leave both panes.
    expect(terminalRef).toBeDefined();
    expect(
      tabsOf(viewTabId, activePane).some(
        (tile) => tile.id === WORKTREE_ENTRY.setupTerminalSessionId,
      ),
    ).toBe(false);
    expect(activePaneIdOrThrow(viewTabId)).toBe(paneA);
    expect(activePane.activeTabId).toBe("unrelated-chat-instance");
    expect(ownerPane.activeTabId).toBe("chat-instance");
    if (terminalRef === undefined) throw new Error("expected a terminal tab");

    // The user closes the auto-opened setup terminal tab.
    act(() => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(viewTabId, paneB, terminalRef.instanceId);
    });
    expect(hasTerminalTab(viewTabId)).toBe(false);

    // Binding churn (a fresh object identity, still running) plus a driver
    // rerender, while the view is still mounted, must not reopen it.
    act(() => {
      handle.store.setState({
        worktreeBinding: { entries: [{ ...WORKTREE_ENTRY }] },
      });
    });
    rerender();
    expect(hasTerminalTab(viewTabId)).toBe(false);
  });
});
