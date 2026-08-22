import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import {
  getPaneScopedDndId,
  getTerminalTileDragId,
} from "@/components/epic-canvas/dnd/dnd";
import {
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { EpicCanvasTerminalTileDragData } from "@/components/epic-canvas/dnd/dnd";

const EPIC_ID = "epic-1";
const HOST_A = "host-a";
const HOST_B = "host-b";
const SHARED_ID = "shared-term";

const durableCollection = vi.hoisted(() => ({
  value: null as PlainTerminalCollection | null,
}));

const draggableCalls = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly id: string;
    readonly data: EpicCanvasTerminalTileDragData;
  }>,
}));

const resourceChipCalls = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly kind: string;
    readonly ownerId: string;
    readonly hostId: string | null;
  }>,
}));

function epicRunningPlainTerminal(
  terminalId: string,
  hostId: string,
  title: string,
): PlainTerminalProjection {
  return {
    record: {
      terminalId,
      hostId,
      scope: { kind: "epic", epicId: EPIC_ID },
      launch: {
        cwd: "/tmp/work",
        shellCommand: "/bin/zsh",
        shellArgs: [],
      },
      manualTitle: title,
      revision: 1,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: terminalId,
      currentCwd: "/tmp/work",
      activeProcessName: null,
      cols: 80,
      rows: 24,
    },
  };
}

function freshPlainCollection(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, terminals),
    ),
    "open",
  );
}

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (args: {
    readonly id: string;
    readonly data: EpicCanvasTerminalTileDragData;
  }) => {
    draggableCalls.calls.push(args);
    return {
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      isDragging: false,
    };
  },
}));

vi.mock("@/components/resources/resource-usage-chip", () => ({
  OwnerResourceChip: (props: {
    readonly kind: string;
    readonly ownerId: string;
    readonly hostId: string | null;
  }) => {
    resourceChipCalls.calls.push(props);
    return (
      <span
        data-testid={`owner-resource-chip-${props.hostId}-${props.ownerId}`}
      />
    );
  },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
  useHostRuntimeClient: () => ({
    resolveHostById: () => null,
    getRequestContext: () => null,
    getRequestContextUserId: () => null,
    createRequester: () => null,
  }),
}));

vi.mock("@/lib/terminals/resolve-plain-terminal-owner-client", () => ({
  useResolvePlainTerminalOwnerHostClient: () => () => ({
    request: vi.fn(),
  }),
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => HOST_A,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => ({ request: vi.fn() }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) =>
      prepare(),
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: [] },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: HOST_A,
    scope: { kind: "epic", epicId: EPIC_ID },
    capability: { status: "capable" },
    canMutate: true,
    collection: durableCollection.value,
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-mutations", () => ({
  useHostPlainTerminalMutations: () => ({
    close: { mutateAsync: vi.fn(), isPending: false },
    rename: { mutate: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly onSelect: () => void;
    readonly "data-testid": string;
    readonly disabled: boolean | undefined;
  }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

import { TerminalsPanelBody } from "../epic-terminal-sidebar";

function wrapper(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SnapshotLoadingProvider
          value={{ snapshotLoaded: true, snapshotFetchError: null }}
        >
          {node}
        </SnapshotLoadingProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe("terminal sidebar fleet identity consumers", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    draggableCalls.calls = [];
    resourceChipCalls.calls = [];
    useSettingsStore.setState({ showNavigatorResourceStats: true });
    durableCollection.value = freshPlainCollection([
      epicRunningPlainTerminal(SHARED_ID, HOST_A, "Host A shell"),
      epicRunningPlainTerminal(SHARED_ID, HOST_B, "Host B shell"),
    ]);
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ showNavigatorResourceStats: false });
  });

  it("highlights, registers DnD, and selects resources per owner host", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    store.openTileInTab(tabId, {
      id: SHARED_ID,
      instanceId: "inst-host-a",
      type: "terminal",
      name: "Host A shell",
      hostId: HOST_A,
      authority: "host",
      legacyFallback: {
        name: "Host A shell",
        titleSource: "manual",
        cwd: "/tmp/work",
      },
    });

    render(wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={tabId} />));

    const hostARow = screen.getByText("Host A shell").closest("button");
    const hostBRow = screen.getByText("Host B shell").closest("button");
    if (hostARow === null || hostBRow === null) {
      throw new Error("expected both fleet rows");
    }
    expect(hostARow.getAttribute("data-terminal-host-id")).toBe(HOST_A);
    expect(hostBRow.getAttribute("data-terminal-host-id")).toBe(HOST_B);
    expect(hostARow.className).toContain("bg-accent font-medium");
    expect(hostBRow.className).not.toContain("font-medium");

    const dragIds = draggableCalls.calls.map((call) => call.id);
    expect(dragIds).toEqual(
      expect.arrayContaining([
        getPaneScopedDndId(tabId, getTerminalTileDragId(SHARED_ID, HOST_A)),
        getPaneScopedDndId(tabId, getTerminalTileDragId(SHARED_ID, HOST_B)),
      ]),
    );
    expect(new Set(dragIds).size).toBe(dragIds.length);
    expect(
      draggableCalls.calls.map((call) => call.data.tile.hostId).sort(),
    ).toEqual([HOST_A, HOST_B].sort());

    expect(resourceChipCalls.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "terminal",
          ownerId: SHARED_ID,
          hostId: HOST_A,
        }),
        expect.objectContaining({
          kind: "terminal",
          ownerId: SHARED_ID,
          hostId: HOST_B,
        }),
      ]),
    );
  });
});
