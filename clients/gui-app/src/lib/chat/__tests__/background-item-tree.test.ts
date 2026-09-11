import { describe, expect, it } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { backgroundKind } from "@/lib/chat/background-item-tree";

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
