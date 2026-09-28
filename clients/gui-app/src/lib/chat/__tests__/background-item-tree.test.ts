import { describe, expect, it } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  backgroundHeaderSummary,
  backgroundSectionCounts,
  buildBackgroundTree,
  buildRememberedBackgroundNodes,
  dedupeByTaskId,
  type BackgroundTreeNode,
} from "@/lib/chat/background-item-tree";

function wakeup(taskId: string, parentTaskId: string | null): BackgroundItem {
  return {
    taskId,
    kind: "wakeup",
    title: `Wake ${taskId}`,
    blockId: `${taskId}-block`,
    parentTaskId,
    scheduledFor: 1,
  };
}

function command(taskId: string): BackgroundItem {
  return {
    taskId,
    kind: "command",
    title: `Command ${taskId}`,
    blockId: `${taskId}-block`,
    parentTaskId: null,
    scheduledFor: null,
    individualStopUnavailable: null,
  };
}

/** The tree {@link backgroundSectionCounts} takes, over the deduped items. */
function treeFor(
  items: ReadonlyArray<BackgroundItem>,
): ReadonlyArray<BackgroundTreeNode> {
  const deduped = dedupeByTaskId(items);
  return buildBackgroundTree(
    deduped,
    buildRememberedBackgroundNodes(deduped, new Map()),
  );
}

/**
 * The one count of what the Background section lists, shared by the panel's
 * header and the compact chip. A shell whose process is alive belongs in the
 * running count however it was started - the caller passes ids the store has
 * already filtered to `status.state === "running"`, and a `monitoring` shell
 * reaches that state like any other.
 */
describe("backgroundSectionCounts", () => {
  it("counts every live shell the caller hands it", () => {
    expect(
      backgroundSectionCounts({
        tree: treeFor([]),
        runningManagedCommandIds: ["watcher-1", "watcher-2"],
        heldManagedCommandIds: [],
        portForwardCount: 0,
      }),
    ).toMatchObject({ runningCount: 2, total: 2 });
  });

  // A hold is what the panel renders instead of the running row, so counting
  // both as running would name a row that is not on screen - but the hold
  // still joins the total, since it is a row the panel does show.
  it("leaves a held shell out of the running count, and counts it as held instead", () => {
    expect(
      backgroundSectionCounts({
        tree: treeFor([]),
        runningManagedCommandIds: ["watcher-1"],
        heldManagedCommandIds: ["watcher-1"],
        portForwardCount: 0,
      }),
    ).toMatchObject({ runningCount: 0, heldCount: 1, total: 1 });
  });

  // A wake is scheduled, not running, so it never joins the running count -
  // but it is not dropped either: it has its own group, `waitingWakeCount`,
  // and that group is counted even when the wake is nested under a running
  // parent, since the panel still renders it as its own row.
  it("counts a pending wake as waiting, never as running, nested or not", () => {
    expect(
      backgroundSectionCounts({
        tree: treeFor([wakeup("w1", null)]),
        runningManagedCommandIds: [],
        heldManagedCommandIds: [],
        portForwardCount: 0,
      }),
    ).toMatchObject({ runningCount: 0, waitingWakeCount: 1, total: 1 });

    // A wake nested under a running parent: the parent's group is running,
    // and the nested wake is still its own waiting row.
    expect(
      backgroundSectionCounts({
        tree: treeFor([command("c1"), wakeup("w1", "c1")]),
        runningManagedCommandIds: [],
        heldManagedCommandIds: [],
        portForwardCount: 0,
      }),
    ).toMatchObject({ runningCount: 1, waitingWakeCount: 1, total: 2 });
  });

  // The panel collapses a transient duplicate `taskId` to one row, so this
  // must too - the chip and the header read from here for exactly that reason.
  it("counts a duplicated task once", () => {
    expect(
      backgroundSectionCounts({
        tree: treeFor([command("c1"), command("c1")]),
        runningManagedCommandIds: [],
        heldManagedCommandIds: [],
        portForwardCount: 0,
      }),
    ).toMatchObject({ runningCount: 1, total: 1 });
  });

  // Every part at once: running items, a managed shell, a held shell and port
  // forwards all add into the one total the chip prints.
  it("sums running, held, waiting and port forwards into one total", () => {
    expect(
      backgroundSectionCounts({
        tree: treeFor([command("c1"), wakeup("w1", null)]),
        runningManagedCommandIds: ["watcher-1"],
        heldManagedCommandIds: ["watcher-2"],
        portForwardCount: 2,
      }),
    ).toMatchObject({
      runningCount: 2,
      heldCount: 1,
      waitingWakeCount: 1,
      portForwardCount: 2,
      total: 6,
    });
  });
});

describe("backgroundHeaderSummary", () => {
  it("says '0 running' when every count is zero", () => {
    expect(
      backgroundHeaderSummary({
        runningCount: 0,
        heldCount: 0,
        waitingWakeCount: 0,
        portForwardCount: 0,
      }),
    ).toBe("0 running");
  });

  it("singularizes a single port forward", () => {
    expect(
      backgroundHeaderSummary({
        runningCount: 0,
        heldCount: 0,
        waitingWakeCount: 0,
        portForwardCount: 1,
      }),
    ).toBe("1 port forward");
  });

  it("pluralizes more than one port forward", () => {
    expect(
      backgroundHeaderSummary({
        runningCount: 0,
        heldCount: 0,
        waitingWakeCount: 0,
        portForwardCount: 3,
      }),
    ).toBe("3 port forwards");
  });

  it("contributes nothing when the port forward count is zero, alongside other non-zero parts", () => {
    expect(
      backgroundHeaderSummary({
        runningCount: 2,
        heldCount: 1,
        waitingWakeCount: 0,
        portForwardCount: 0,
      }),
    ).toBe("2 running · 1 held");
  });

  // Composition order the implementation uses: running, held, waiting, then
  // port forwards last.
  it("composes with the existing parts in running, held, waiting, port-forward order", () => {
    expect(
      backgroundHeaderSummary({
        runningCount: 2,
        heldCount: 1,
        waitingWakeCount: 4,
        portForwardCount: 1,
      }),
    ).toBe("2 running · 1 held · 4 waiting · 1 port forward");
  });
});
