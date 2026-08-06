import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommandListStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import type { OwnerResourceSnapshotWireV14 } from "@traycer/protocol/host/resources/subscribe";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

/**
 * The "Monitors & Shells" section (`UI.md` §1, §3, §9): every managed command
 * in the epic, kind-explicit, running first, each row a door to its output
 * window and a backlink to the agent that created it.
 */

const streamSupport = vi.hoisted<{ value: string | null }>(() => ({
  value: "supported",
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => streamSupport.value,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

// Host RPC is the boundary; the buttons themselves have their own test.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
  }),
);

import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { createOpenEpicStore } from "@/stores/epics/open-epic/store";
import { ManagedCommandListStreamMount } from "@/providers/managed-command-list-stream-mount";
import { __setManagedCommandListStreamClientFactoryForTests } from "@/providers/managed-command-list-stream-factory-override";
import { managedCommandListRegistry } from "@/stores/managed-commands/managed-command-list-registry";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { ManagedCommandsPanelBody } from "../managed-command-sidebar";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";

function command(over: Partial<ManagedCommand>): ManagedCommand {
  return {
    id: "cmd-1",
    kind: "monitor",
    description: "deploy watcher",
    status: { state: "running", pid: 4410, startedAtMs: 10 },
    chatId: "chat-1",
    createdAtMs: 10,
    updatedAtMs: 10,
    ...over,
  };
}

const MONITOR = command({
  id: "cmd-monitor",
  kind: "monitor",
  description: "deploy watcher",
  status: { state: "running", pid: 4410, startedAtMs: 100 },
  updatedAtMs: 100,
});

const SHELL = command({
  id: "cmd-shell",
  kind: "shell",
  description: "db migration",
  status: { state: "exited", exitCode: 1, signal: null, exitedAtMs: 900 },
  updatedAtMs: 900,
});

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

function installResourcesStub(): { emit: () => ResourcesStreamCallbacks } {
  let captured: ResourcesStreamCallbacks | null = null;
  __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("resources callbacks not wired");
      return captured;
    },
  };
}

function managedCommandOwner(commandId: string): OwnerResourceSnapshotWireV14 {
  return {
    owner: {
      kind: "managed-command",
      hostId: "host-1",
      epicId: EPIC_ID,
      ownerId: commandId,
    },
    sampledAt: 1_000,
    rootPids: [30],
    harnessId: null,
    activeProcessName: "node",
    processCount: 2,
    cpuPercent: 7,
    rssBytes: 64 * 1024 * 1024,
    processes: [],
    managedCommand: {
      commandId,
      kind: "monitor",
      description: "deploy watcher",
    },
  };
}

function projection(
  owners: readonly OwnerResourceSnapshotWireV14[],
): ResourcesProjectionPayload {
  return {
    epicId: EPIC_ID,
    sampledAt: 1_000,
    app: null,
    owners,
    epic: null,
    epics: [],
    hostTree: undefined,
    other: undefined,
  };
}

function renderSection(node: ReactNode): void {
  render(
    <EpicSessionContext.Provider value={epicHandle}>
      <TooltipProvider>{node}</TooltipProvider>
    </EpicSessionContext.Provider>,
  );
}

function renderPanel(): void {
  renderSection(
    <>
      <ManagedCommandListStreamMount epicId={EPIC_ID} />
      <ManagedCommandsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />
    </>,
  );
}

function rowTitles(): (string | null)[] {
  return screen
    .getAllByTestId(/^managed-command-row-title-/)
    .map((node) => node.textContent);
}

beforeEach(() => {
  streamSupport.value = "supported";
  useSettingsStore.setState({ showNavigatorResourceStats: true });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  epicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
});

afterEach(() => {
  cleanup();
  __setManagedCommandListStreamClientFactoryForTests(null);
  __setResourcesStreamClientFactoryForTests(null);
  managedCommandListRegistry.disposeAll();
  resourcesRegistry.disposeAll();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("Monitors & Shells section", () => {
  it("names the kind on every row and leads with what is running", () => {
    const list = installListStub();
    renderPanel();

    act(() => {
      list.emit().onSnapshot([SHELL, MONITOR]);
    });

    // The shell exited more recently, but a running monitor still leads.
    expect(rowTitles()).toEqual([
      "Monitor · deploy watcher",
      "Shell · db migration",
    ]);
    expect(
      screen.getByTestId("managed-command-status-cmd-shell").textContent,
    ).toBe("Exited · code 1");
    expect(
      screen.getByTestId("managed-command-status-cmd-monitor").textContent,
    ).toBe("Running");
  });

  it("opens the command's output window when a row is clicked", () => {
    const list = installListStub();
    renderPanel();
    act(() => {
      list.emit().onSnapshot([MONITOR]);
    });

    fireEvent.click(screen.getByTestId("managed-command-row-cmd-monitor"));

    const opened = findOpenArtifactInTab(TAB_ID, "cmd-monitor");
    expect(opened).not.toBeNull();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.tilesByInstanceId[
        opened?.instanceId ?? ""
      ]?.type,
    ).toBe("managed-command-output");
  });

  it("makes the door a real button, so the platform activates it", () => {
    const list = installListStub();
    renderPanel();
    act(() => {
      list.emit().onSnapshot([MONITOR]);
    });

    // Named by the title it carries, and a `<button>` rather than a div wearing
    // the role - which is what buys keyboard activation without a hand-rolled
    // keydown handler.
    const door = screen.getByRole("button", {
      name: /Monitor · deploy watcher/,
    });
    expect(door.tagName).toBe("BUTTON");
    expect(door).toBe(screen.getByTestId("managed-command-row-cmd-monitor"));
  });

  it("keeps Stop, Delete and the backlink reachable as their own controls", () => {
    const list = installListStub();
    epicHandle.store.setState((state) => ({
      chats: {
        byId: { ...state.chats.byId, "chat-1": makeChatProjection() },
        allIds: ["chat-1"],
      },
    }));
    renderPanel();
    act(() => {
      list.emit().onSnapshot([MONITOR]);
    });

    // A button flattens its subtree to presentational, so a control nested
    // inside the door would vanish from the accessibility tree. Each of these
    // has to be a sibling of it, not a child.
    const door = screen.getByTestId("managed-command-row-cmd-monitor");
    for (const name of ["Stop", "Delete", "Open Deploy work"]) {
      const control = screen.getByRole("button", { name });
      expect(door.contains(control)).toBe(false);
    }

    // And pressing one is that control's business alone.
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(findOpenArtifactInTab(TAB_ID, "cmd-monitor")).toBeNull();
  });

  it("links back to the agent that created the command", () => {
    const list = installListStub();
    epicHandle.store.setState((state) => ({
      chats: {
        byId: {
          ...state.chats.byId,
          "chat-1": {
            ...makeChatProjection(),
          },
        },
        allIds: ["chat-1"],
      },
    }));
    renderPanel();
    act(() => {
      list.emit().onSnapshot([MONITOR]);
    });

    fireEvent.click(screen.getByTestId("managed-command-backlink-cmd-monitor"));

    expect(findOpenArtifactInTab(TAB_ID, "chat-1")).not.toBeNull();
  });

  it("shows live CPU and memory for a running command", () => {
    const list = installListStub();
    const resources = installResourcesStub();
    renderSection(
      <>
        <ManagedCommandListStreamMount epicId={EPIC_ID} />
        <ResourcesStreamMount epicId={EPIC_ID} />
        <ManagedCommandsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />
      </>,
    );

    act(() => {
      list.emit().onSnapshot([MONITOR]);
    });
    act(() => {
      resources
        .emit()
        .onSnapshot(projection([managedCommandOwner("cmd-monitor")]));
    });

    // Per `format-resource-usage`: CPU under 10 keeps one decimal, and memory
    // under 100 units does too - so 7% of a core and 64 MiB read like this.
    expect(
      screen.getByLabelText(
        "Resource usage: 7.0% CPU, 64.0 MB memory, 2 processes",
      ),
    ).not.toBeNull();
  });

  it("says the epic has none rather than staying blank", () => {
    const list = installListStub();
    renderPanel();

    act(() => {
      list.emit().onSnapshot([]);
    });

    expect(screen.getByTestId("managed-command-sidebar-empty")).not.toBeNull();
  });

  it("reads as unavailable on a host that does not serve the stream", () => {
    streamSupport.value = "unsupported";
    installListStub();
    renderPanel();

    // Not the same as an epic with no monitors: the host simply cannot answer.
    expect(
      screen.getByTestId("managed-command-sidebar-unavailable"),
    ).not.toBeNull();
    expect(screen.queryByTestId("managed-command-sidebar-empty")).toBeNull();
  });

  it("flags a lost host while keeping the last known rows", () => {
    const list = installListStub();
    renderPanel();
    act(() => {
      list.emit().onSnapshot([MONITOR]);
    });

    act(() => {
      list.emit().onConnectionStatus("reconnecting", null);
    });

    expect(
      screen.getByTestId("managed-command-sidebar-disconnected"),
    ).not.toBeNull();
    expect(rowTitles()).toEqual(["Monitor · deploy watcher"]);
  });
});

function makeChatProjection(): ChatProjection {
  return {
    id: "chat-1",
    title: "Deploy work",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-1",
    isTitleEditedByUser: false,
    settings: null,
    archivedAt: null,
  };
}
