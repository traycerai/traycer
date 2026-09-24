import { describe, expect, it } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  backgroundHeaderSummary,
  backgroundRunningRowCount,
} from "@/lib/chat/background-item-tree";

function wakeup(taskId: string): BackgroundItem {
  return {
    taskId,
    kind: "wakeup",
    title: `Wake ${taskId}`,
    blockId: `${taskId}-block`,
    parentTaskId: null,
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

/**
 * The predicate behind the compact chip's number and its whole live treatment.
 * A shell whose process is alive belongs in it however it was started - the
 * caller passes ids the store has already filtered to `status.state ===
 * "running"`, and a `monitoring` shell reaches that state like any other.
 */
describe("backgroundRunningRowCount", () => {
  it("counts every live shell the caller hands it", () => {
    expect(
      backgroundRunningRowCount({
        items: [],
        runningManagedCommandIds: ["watcher-1", "watcher-2"],
        heldManagedCommandIds: [],
      }),
    ).toBe(2);
  });

  // A hold is what the panel renders instead of the running row, so counting
  // both would name a row that is not on screen.
  it("leaves a held shell out of the running total", () => {
    expect(
      backgroundRunningRowCount({
        items: [],
        runningManagedCommandIds: ["watcher-1"],
        heldManagedCommandIds: ["watcher-1"],
      }),
    ).toBe(0);
  });

  // A wake is scheduled, not running; every other kind of delivered row is
  // work in flight. Both halves add up, since a shell is not a harness row.
  it("counts delivered rows but never a pending wake", () => {
    expect(
      backgroundRunningRowCount({
        items: [wakeup("w1")],
        runningManagedCommandIds: [],
        heldManagedCommandIds: [],
      }),
    ).toBe(0);
    expect(
      backgroundRunningRowCount({
        items: [command("c1"), wakeup("w1")],
        runningManagedCommandIds: ["watcher-1"],
        heldManagedCommandIds: [],
      }),
    ).toBe(2);
  });

  // The panel collapses a transient duplicate `taskId` to one row, so this
  // must too - the chip and the header read from here for exactly that reason.
  it("counts a duplicated task once", () => {
    expect(
      backgroundRunningRowCount({
        items: [command("c1"), command("c1")],
        runningManagedCommandIds: [],
        heldManagedCommandIds: [],
      }),
    ).toBe(1);
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
