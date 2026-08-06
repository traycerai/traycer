import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommandListStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import type { ChatLowerSurfaceTopSpacing } from "@/components/chat/chat-pinned-stack";

/**
 * The dock's frame is drawn flush against whatever follows it (`-mb-px`, no
 * bottom border), so the surfaces below have to agree with the dock about
 * whether the Background section is there at all. A chat whose only background
 * work is a managed command is the case where the two used to disagree: the
 * dock joined the epic's command list, the composer only ever looked at the
 * harness's own background items, and the result was an open-bottomed box with
 * a gap under it.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
  }),
);

// The composer's own spacing is one class off its `topSpacing` prop
// (`pt-4` for "normal", `pt-0` for "connected"), so the stub records the
// decision and spares the test the composer's whole provider stack.
vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: {
    readonly topSpacing: ChatLowerSurfaceTopSpacing;
  }) => <div data-testid="composer-stub" data-top-spacing={props.topSpacing} />,
}));
vi.mock("@/components/chat/chat-stop-children-dialog", () => ({
  StopChildrenDialog: () => null,
}));
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));
vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({ mutate: () => undefined }),
}));

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { ManagedCommandListStreamMount } from "@/providers/managed-command-list-stream-mount";
import { __setManagedCommandListStreamClientFactoryForTests } from "@/providers/managed-command-list-stream-factory-override";
import { managedCommandListRegistry } from "@/stores/managed-commands/managed-command-list-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";

const RESTORE_CONTEXT: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: "user-1",
  activeHostId: "host-1",
  activeTurnStatus: null,
  localSnapshotsClearedAt: null,
  restore: null,
  restoreActionPending: false,
  restoreCheckpoint: () => null,
  accumulatedFileChanges: [],
  revertFileChanges: () => null,
};

const RUNNING_MONITOR: ManagedCommand = {
  id: "cmd-monitor",
  kind: "monitor",
  description: "deploy watcher",
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: CHAT_ID,
  createdAtMs: 10,
  updatedAtMs: 10,
};

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle;

function installListStub(): { emit: () => ManagedCommandListStreamCallbacks } {
  let captured: ManagedCommandListStreamCallbacks | null = null;
  __setManagedCommandListStreamClientFactoryForTests((_epicId, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("list callbacks not wired");
      return captured;
    },
  };
}

function surfacesProps(): ChatLowerInteractionSurfacesProps {
  return {
    epicId: EPIC_ID,
    viewTabId: TAB_ID,
    chatId: CHAT_ID,
    runtime: { snapshotLoaded: true },
    access: { isViewer: false, canAct: true },
    turn: {
      activeTurnStatus: null,
      steerCapable: false,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      stopDisabled: true,
      onStopTurn: () => null,
    },
    interview: {
      pending: null,
      isBusy: false,
      unanswerable: [],
      unanswerableBusy: false,
      onAnswer: () => null,
      onError: () => null,
      onFork: null,
    },
    approvals: {
      pendingFileEditApprovals: [],
      pendingApprovals: [],
      onFileEditDecision: () => undefined,
      onApprovalDecision: () => undefined,
    },
    queue: {
      editingItem: null,
      editingItemId: null,
      value: { status: "idle", items: [] },
      onPause: () => null,
      onResume: () => null,
      onEdit: () => undefined,
      onCancel: () => undefined,
      onAbortSteer: () => undefined,
      onCancelEdit: () => undefined,
      onStopBackgroundItem: () => null,
      onStopAllBackgroundItems: () => null,
      onReorder: () => undefined,
      onSteerNow: () => undefined,
    },
    composer: {
      sessionSettingsSeed: null,
      fallbackSettingsSeed: null,
      nodeId: CHAT_ID,
      isActive: true,
      mentionRoots: [],
      fallbackToGlobalMentionRoots: true,
      currentEpicId: EPIC_ID,
      onSubmitMessage: () => false,
      onSettingsChange: null,
      workspaceControls: null,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
    },
    todo: null,
    restoreContext: RESTORE_CONTEXT,
    // The harness session reports nothing of its own - the whole point of the
    // case: everything below the transcript comes from the command list.
    backgroundItems: [],
    backgroundStopPendingTaskIds: new Set(),
    backgroundStopAllPending: false,
    onBackgroundItemClick: () => undefined,
  };
}

function renderInChatTile(node: ReactNode): void {
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId="host-1">
        <TooltipProvider>{node}</TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>,
  );
}

function renderSurfaces(): { emit: () => ManagedCommandListStreamCallbacks } {
  const stub = installListStub();
  renderInChatTile(
    <>
      <ManagedCommandListStreamMount epicId={EPIC_ID} />
      <ChatLowerInteractionSurfaces {...surfacesProps()} />
    </>,
  );
  return stub;
}

function composerTopSpacing(): string | null {
  return screen.getByTestId("composer-stub").getAttribute("data-top-spacing");
}

beforeEach(() => {
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
});

afterEach(() => {
  cleanup();
  __setManagedCommandListStreamClientFactoryForTests(null);
  managedCommandListRegistry.disposeAll();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("background section and composer spacing", () => {
  it("keeps the composer flush when a managed command is the only background work", () => {
    const stub = renderSurfaces();

    act(() => {
      stub.emit().onSnapshot([RUNNING_MONITOR]);
    });

    expect(screen.getByTestId("chat-lower-dock")).not.toBeNull();
    expect(screen.getByTestId("background-items-panel")).not.toBeNull();
    // "connected" is `pt-0`: the dock's frame has no bottom edge of its own, so
    // any gap here shows as an open box.
    expect(composerTopSpacing()).toBe("connected");
  });

  it("pays the normal top spacing when nothing is docked above the composer", () => {
    const stub = renderSurfaces();

    act(() => {
      stub.emit().onSnapshot([]);
    });

    expect(screen.queryByTestId("chat-lower-dock")).toBeNull();
    expect(composerTopSpacing()).toBe("normal");
  });
});
