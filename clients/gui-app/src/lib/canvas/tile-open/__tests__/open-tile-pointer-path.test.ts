/**
 * The open a person's click makes, end to end through the real seam: a palette
 * opener leaf (`openerExistingLeaf`), `openTileWithNavigation`, the real
 * planner and the real canvas store with a real pane. Nothing is mocked.
 *
 * The seam mints the id of a tile it opens into a pane and marks THAT id as
 * requested; a tile mounted under any other id would read as restored and
 * never start the sandbox wake or the agent the open asked for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openerExistingLeaf } from "@/lib/commands/sources/open/open-leaf";
import type { CommandContext } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { wasTileOpenRequested } from "../tile-open-provenance";

const ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

/** The row's ref: its instance id is a placeholder that outlives every open of the row. */
const ROW_REF: EpicNodeRef = {
  id: "chat-seam",
  instanceId: "row-placeholder",
  type: "chat",
  name: "Seam chat",
  hostId: "host-a",
};

interface Task {
  readonly tabId: string;
  readonly ctx: CommandContext;
}

/** A task tab whose canvas holds one pane with a spec in it, and the context the palette opens into it with. */
function taskTab(epicId: string): Task {
  const canvas = useEpicCanvasStore.getState();
  const tabId = canvas.openEpicTab(epicId, epicId);
  canvas.openTileInTab(tabId, {
    id: `spec-${epicId}`,
    instanceId: `inst-spec-${epicId}`,
    type: "spec",
    name: "Plan",
    hostId: "host-a",
  });
  const paneId =
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null;
  return {
    tabId,
    ctx: {
      pathname: "/",
      router: ROUTER,
      activeTabId: tabId,
      activeEpicId: epicId,
      focusedComposerKind: null,
      targetGroupId: paneId,
    },
  };
}

/** The instance ids of the row's tile on a tab's canvas. */
function rowTilesOn(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  return Object.values(canvas?.tilesByInstanceId ?? {}).flatMap((ref) =>
    ref?.id === ROW_REF.id ? [ref.instanceId] : [],
  );
}

function clickRow(task: Task): void {
  const leaf = openerExistingLeaf("chats", task.ctx, ROW_REF, null);
  void leaf.run(task.ctx);
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

describe("a palette opener leaf that opens a tile into a pane", () => {
  it("mounts the tile under an id of its own, and that id reads as requested", () => {
    const task = taskTab("epic-seam-1");

    clickRow(task);

    const opened = rowTilesOn(task.tabId);
    expect(opened).toHaveLength(1);
    expect(opened).not.toContain(ROW_REF.instanceId);
    expect(opened.map((id) => wasTileOpenRequested(id))).toEqual([true]);
  });

  it("opens a second tile each time it is run, each under its own id and each requested", () => {
    const task = taskTab("epic-seam-2");

    clickRow(task);
    clickRow(task);

    const opened = rowTilesOn(task.tabId);
    expect(opened).toHaveLength(2);
    expect(new Set(opened).size).toBe(2);
    expect(opened.every((id) => wasTileOpenRequested(id))).toBe(true);
  });

  it("opens the same row on two tabs without reusing the row's id, so no id lives on both", () => {
    const first = taskTab("epic-seam-3");
    const second = taskTab("epic-seam-4");

    expect(() => {
      clickRow(first);
      clickRow(second);
    }).not.toThrow();

    const onFirst = rowTilesOn(first.tabId);
    const onSecond = rowTilesOn(second.tabId);
    expect(onFirst).toHaveLength(1);
    expect(onSecond).toHaveLength(1);
    expect([...onFirst, ...onSecond]).not.toContain(ROW_REF.instanceId);
    expect(onFirst).not.toEqual(onSecond);
  });
});
