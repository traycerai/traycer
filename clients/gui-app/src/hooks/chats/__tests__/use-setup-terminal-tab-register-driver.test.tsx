import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeBindingEntry } from "@traycer/protocol/host";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useSetupTerminalTabRegisterDriver } from "@/hooks/chats/use-setup-terminal-tab-register-driver";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useSetupTerminalRegistrationStore } from "@/stores/chats/setup-terminal-registration-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";

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
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, _callbacks) => {
      return {
        sendAction: () => undefined,
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

    renderHook(() => useSetupTerminalTabRegisterDriver({ handle, viewTabId }), {
      wrapper: Wrapper,
    });

    const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    expect(canvas?.root).not.toBeNull();
    if (canvas === undefined || canvas.root === null) return;
    const tiles = collectPanes(canvas.root).flatMap((pane) =>
      paneTabRefs(canvas, pane),
    );
    expect(tiles).toContainEqual({
      id: WORKTREE_ENTRY.setupTerminalSessionId,
      instanceId: WORKTREE_ENTRY.setupTerminalSessionId,
      type: "terminal",
      name: "Setup: traycer feature/setup-title",
      titleSource: "manual",
      hostId: HOST_ID,
      cwd: WORKTREE_ENTRY.worktreePath,
    });
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

    renderHook(() => useSetupTerminalTabRegisterDriver({ handle, viewTabId }), {
      wrapper: Wrapper,
    });

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
});
