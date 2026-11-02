import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import { sandboxHostEntryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { openTileIntoTargetGroup } from "@/lib/commands/actions/open-into-target";
import { startSandboxWake } from "@/lib/sandboxes/sandbox-wake";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

// The directory's answer for the tile's host, a host runtime above it, and the
// wake itself: everything else, the provenance of the open, the wake hook, the
// element `renderTile` mounts and the open seam, is the real one.
const hostFacts = vi.hoisted(() => ({
  entry: null as HostDirectoryEntry | null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hostFacts.entry,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({}),
}));
vi.mock("@/lib/sandboxes/sandbox-wake", () => ({
  startSandboxWake: vi.fn<typeof startSandboxWake>(() => Promise.resolve(null)),
}));

const BASE_NODE = {
  id: "node-1",
  instanceId: "instance-1",
  name: "Node",
  hostId: "host-sbx",
};

interface WakeProps {
  readonly gesture: SandboxVerbGesture | null;
  readonly hostId: string;
}

/** The element a tile mounts to wake its host when the tile is opened. */
function wakeElementOf(node: EpicCanvasTileRef): ReactElement<WakeProps> {
  const tree: ReactNode = renderTile({
    node,
    viewTabId: "tab-1",
    tileId: "tile-1",
    epicId: "epic-1",
    isActive: true,
  });
  if (!isValidElement<{ children: ReactNode }>(tree)) {
    throw new Error("renderTile did not return an element");
  }
  for (const child of Children.toArray(tree.props.children)) {
    if (isValidElement<WakeProps>(child) && "gesture" in child.props) {
      expect(child.props.hostId).toBe("host-sbx");
      return child;
    }
  }
  throw new Error("no wake element under the tile's host provider");
}

/** The gesture the tile's open wake is mounted with. */
function wakeGestureOf(node: EpicCanvasTileRef): SandboxVerbGesture | null {
  return wakeElementOf(node).props.gesture;
}

describe("the tile-open wake's gesture", () => {
  it("is Open terminal for a terminal tile", () => {
    expect(
      wakeGestureOf({
        ...BASE_NODE,
        type: "terminal",
        titleSource: "default",
        cwd: "/tmp",
      }),
    ).toBe("open-terminal");
  });

  it("is Open files for a workspace file tile", () => {
    expect(
      wakeGestureOf({
        ...BASE_NODE,
        type: "workspace-file",
        workspacePath: "/repo",
        filePath: "src/a.ts",
      }),
    ).toBe("open-files");
  });

  it("is none for a chat tile", () => {
    expect(wakeGestureOf({ ...BASE_NODE, type: "chat" })).toBeNull();
  });
});

describe("the wake of a tile a layout restored", () => {
  beforeEach(() => {
    hostFacts.entry = sandboxHostEntryFixture("host-sbx", "suspended");
    vi.mocked(startSandboxWake).mockClear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });
  afterEach(cleanup);

  it("does not start until something opens the tile, and an open of a second view of it, which the canvas folds into the one it has, starts it", () => {
    const restored: EpicCanvasTileRef = {
      ...BASE_NODE,
      instanceId: "inst-restored-wake",
      type: "chat",
    };
    const canvas = useEpicCanvasStore.getState();
    const tabId = canvas.openEpicTab("epic-1", "Task");
    canvas.openTileInTab(tabId, restored);
    const paneId =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null;
    render(
      <QueryClientProvider client={new QueryClient()}>
        {wakeElementOf(restored)}
      </QueryClientProvider>,
    );
    expect(startSandboxWake).not.toHaveBeenCalled();

    act(() => {
      openTileIntoTargetGroup({
        tabId,
        groupId: paneId,
        ref: { ...restored, instanceId: "inst-minted-wake" },
        dedupe: true,
        navigateNestedFocus: undefined,
      });
    });

    expect(startSandboxWake).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startSandboxWake).mock.calls.at(0)?.[2]).toBe("host-sbx");
    expect(
      Object.keys(
        useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId ??
          {},
      ),
    ).toEqual([restored.instanceId]);
  });
});
