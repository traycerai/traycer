import { describe, expect, it } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  backgroundKind,
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

function subagent(taskId: string): BackgroundItem {
  return {
    taskId,
    kind: "subagent",
    title: `Sub-agent ${taskId}`,
    blockId: `${taskId}-block`,
    parentTaskId: null,
    scheduledFor: null,
  };
}

describe("backgroundKind", () => {
  it("names the one kind every row shares", () => {
    expect(
      backgroundKind({
        items: [wakeup("w1"), wakeup("w2")],
        hasManagedCommands: false,
      }),
    ).toBe("wakeup");
  });

  it("reads as mixed when rows differ in kind", () => {
    expect(
      backgroundKind({
        items: [wakeup("w1"), subagent("s1")],
        hasManagedCommands: false,
      }),
    ).toBe("mixed");
  });

  // A managed shell is not a harness `command` row: the panel draws the two
  // from different glyph families, so a section holding one of each shares no
  // glyph to borrow.
  it("keeps managed shells apart from harness command rows", () => {
    expect(backgroundKind({ items: [], hasManagedCommands: true })).toBe(
      "managedShell",
    );
    expect(
      backgroundKind({
        items: [command("c1")],
        hasManagedCommands: true,
      }),
    ).toBe("mixed");
    expect(
      backgroundKind({
        items: [command("c1")],
        hasManagedCommands: false,
      }),
    ).toBe("command");
    expect(
      backgroundKind({
        items: [wakeup("w1")],
        hasManagedCommands: true,
      }),
    ).toBe("mixed");
  });

  it("claims no kind for an empty section", () => {
    expect(backgroundKind({ items: [], hasManagedCommands: false })).toBe(
      "mixed",
    );
  });
});

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
