import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { v4 as uuidv4 } from "uuid";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useNewTerminalModalOpenStore } from "@/stores/epics/new-terminal-modal-open-store";

const selectById = vi.fn();

interface BindingsQueryStub {
  readonly data:
    | {
        readonly rows: WorktreeBindingSelectorRow[];
        readonly folderlessCwd: string | null;
      }
    | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

const bindingsQuery = vi.hoisted(() => ({
  current: null as BindingsQueryStub | null,
}));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => bindingsQuery.current,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-1",
        label: "MacBook",
        kind: "local",
        websocketUrl: null,
        version: null,
        status: "available",
      },
      {
        hostId: "host-2",
        label: "Remote Box",
        kind: "remote",
        websocketUrl: null,
        version: null,
        status: "available",
      },
    ],
  }),
}));

// The active host is "host-1"; folder rows below span both hosts so a pick
// can differ from it.
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { refresh: () => Promise.resolve([]), selectById },
  }),
}));

function makeRow(
  hostId: string,
  runningDir: string,
  branch: string,
  isPrimary: boolean,
): WorktreeBindingSelectorRow {
  return {
    hostId,
    runningDir,
    workspacePath: "/work/traycer",
    worktreePath: runningDir,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: { owner: "traycer", repo: "traycer" },
    branch,
    isPrimary,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
  };
}

function stubLoadedBindings(): void {
  bindingsQuery.current = {
    data: {
      rows: [
        makeRow("host-1", "/work/traycer", "main", true),
        makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x", false),
      ],
      folderlessCwd: "/Users/tgill",
    },
    isPending: false,
    isError: false,
  };
}

import { NewTerminalDialogHost } from "../new-terminal-dialog";

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function tabTiles(tabId: string): ReadonlyArray<EpicCanvasTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root).flatMap((pane) => paneTabRefs(canvas, pane));
}

function openTabWithGroup(): { tabId: string; groupId: string } {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  // `openTileIntoTargetGroup` (-> `openTileInPane`) never bootstraps an empty
  // canvas - it no-ops unless `paneId` already resolves to a real pane. Seed
  // one via a plain tile open first, mirroring how the palette's
  // target-group flow always targets an already-existing (if empty) pane.
  useEpicCanvasStore.getState().openTileInTab(tabId, {
    id: "seed-chat",
    instanceId: uuidv4(),
    type: "chat",
    name: "Seed",
    hostId: "host-1",
  });
  const groupId =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId;
  if (groupId === null || groupId === undefined) {
    throw new Error("expected a default pane group");
  }
  return { tabId, groupId };
}

describe("<NewTerminalDialogHost />", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    selectById.mockClear();
    stubLoadedBindings();
    useNewTerminalModalOpenStore.getState().close();
  });

  afterEach(() => {
    useNewTerminalModalOpenStore.getState().close();
  });

  it("stays closed until the store request targets this epic + tab", () => {
    const { tabId } = openTabWithGroup();
    render(<NewTerminalDialogHost epicId="epic-1" tabId={tabId} />);

    expect(screen.queryByTestId("new-terminal-dialog")).toBeNull();
  });

  it("opens the picker when the palette's Create-new-terminal row requests it", () => {
    const { tabId, groupId } = openTabWithGroup();
    render(<NewTerminalDialogHost epicId="epic-1" tabId={tabId} />);

    act(() => {
      useNewTerminalModalOpenStore.getState().open({
        epicId: "epic-1",
        tabId,
        groupId,
      });
    });

    expect(screen.getByTestId("new-terminal-dialog")).not.toBeNull();
    expect(
      screen.getByRole("option", { name: /traycer.*main/i }),
    ).not.toBeNull();
    expect(screen.getByRole("option", { name: /feature-x/i })).not.toBeNull();
  });

  it("launches the terminal bound to the explicitly picked host, not the active host", () => {
    const { tabId, groupId } = openTabWithGroup();
    render(<NewTerminalDialogHost epicId="epic-1" tabId={tabId} />);

    act(() => {
      useNewTerminalModalOpenStore.getState().open({
        epicId: "epic-1",
        tabId,
        groupId,
      });
    });

    // "feature-x" lives on host-2; the active host is host-1.
    fireEvent.click(screen.getByRole("option", { name: /feature-x/i }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter((t) => t.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].hostId).toBe("host-2");
    expect(terminals[0].cwd).toBe("/work/traycer-wt/feature-x");
    expect(useNewTerminalModalOpenStore.getState().request).toBeNull();
    expect(screen.queryByTestId("new-terminal-dialog")).toBeNull();
  });

  it("closes via its own close button, not just Escape or a launch", () => {
    const { tabId, groupId } = openTabWithGroup();
    render(<NewTerminalDialogHost epicId="epic-1" tabId={tabId} />);

    act(() => {
      useNewTerminalModalOpenStore.getState().open({
        epicId: "epic-1",
        tabId,
        groupId,
      });
    });
    expect(screen.getByTestId("new-terminal-dialog")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useNewTerminalModalOpenStore.getState().request).toBeNull();
    expect(screen.queryByTestId("new-terminal-dialog")).toBeNull();
  });

  it("clears a matching open request when its host unmounts during a tab switch", () => {
    const { tabId, groupId } = openTabWithGroup();
    const rendered = render(
      <NewTerminalDialogHost epicId="epic-1" tabId={tabId} />,
    );

    act(() => {
      useNewTerminalModalOpenStore.getState().open({
        epicId: "epic-1",
        tabId,
        groupId,
      });
    });
    expect(useNewTerminalModalOpenStore.getState().request).not.toBeNull();

    rendered.unmount();

    expect(useNewTerminalModalOpenStore.getState().request).toBeNull();
  });
});
