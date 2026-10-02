import { describe, expect, it } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { subagentOwnedBackgroundItemCount } from "@/components/chat/segments/subagent-display";
import type {
  SubagentChildSegment,
  SubagentSegment,
} from "@/stores/composer/chat-store";

function card(
  id: string,
  children: ReadonlyArray<SubagentChildSegment>,
): SubagentSegment {
  return {
    id,
    kind: "subagent",
    name: `${id}-agent`,
    agentType: null,
    task: `${id} task`,
    progressUpdates: [],
    result: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId: null,
    workflowMeta: null,
    children,
  };
}

function textChild(id: string, parentId: string): SubagentChildSegment {
  return {
    id,
    kind: "text",
    markdown: `${id} words`,
    isStreaming: false,
    parentId,
  };
}

function command(
  taskId: string,
  blockId: string,
  parentTaskId: string | null,
): BackgroundItem {
  return {
    taskId,
    kind: "command",
    title: `Command ${taskId}`,
    blockId,
    parentTaskId,
    scheduledFor: null,
    individualStopUnavailable: null,
  };
}

/**
 * `parent` holds a text block and a nested card `child`, which holds its own
 * text block - so there is a direct child id and a grandchild id to point
 * background items at.
 */
function nestedCard(): SubagentSegment {
  const child = card("child", [textChild("grandchild-text", "child")]);
  return card("parent", [textChild("child-text", "parent"), child]);
}

describe("subagentOwnedBackgroundItemCount", () => {
  it("is zero when there are no items", () => {
    expect(subagentOwnedBackgroundItemCount(nestedCard(), [])).toBe(0);
  });

  it("counts an item whose block is one of the card's child segments", () => {
    const items = [command("task-1", "child-text", null)];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
  });

  it("counts an item whose block is inside a nested subagent child", () => {
    const items = [command("task-1", "grandchild-text", null)];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
  });

  it("counts an item whose block is the nested subagent card itself", () => {
    const items = [command("task-1", "child", null)];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
  });

  it("does not count the card's own item", () => {
    const items = [command("task-parent", "parent", null)];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(0);
  });

  it("does not count an unrelated root item", () => {
    const items = [command("task-other", "other-block", null)];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(0);
  });

  it("counts only the owned items among a mixed list", () => {
    const items = [
      command("task-parent", "parent", null),
      command("task-owned", "child-text", null),
      command("task-other", "other-block", null),
    ];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
  });

  describe("parentTaskId chain", () => {
    it("counts an item with no matching block whose parent is the card's own item", () => {
      const items = [
        command("task-parent", "parent", null),
        command("task-nested", "no-such-block", "task-parent"),
      ];
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
    });

    it("counts an item two levels down the chain from the card's own item", () => {
      const items = [
        command("task-parent", "parent", null),
        command("task-mid", "no-such-block", "task-parent"),
        command("task-leaf", "no-such-block-either", "task-mid"),
      ];
      // The mid item and the leaf under it are both the subagent's work; the
      // card's own item is not.
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(2);
    });

    it("counts an item whose parent's block is drawn inside the card", () => {
      const items = [
        command("task-owned", "grandchild-text", null),
        command("task-spawned", "no-such-block", "task-owned"),
      ];
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(2);
    });

    it("does not count an item whose parent is an unrelated root item", () => {
      const items = [
        command("task-parent", "parent", null),
        command("task-other", "other-block", null),
        command("task-spawned", "no-such-block", "task-other"),
      ];
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(0);
    });

    it("does not count an item whose parent has no row", () => {
      const items = [command("task-orphan", "no-such-block", "task-missing")];
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(0);
    });

    it("terminates on a parentTaskId cycle and does not count it", () => {
      const items = [
        command("task-a", "no-such-block", "task-b"),
        command("task-b", "no-such-block-either", "task-a"),
      ];
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(0);
    });

    it("terminates on an item that names itself as its parent", () => {
      const items = [command("task-self", "no-such-block", "task-self")];
      expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(0);
    });
  });

  it("does not count a scheduled wake the card owns: it is waiting, not running", () => {
    const wake: BackgroundItem = {
      taskId: "task-wake",
      title: "wake",
      blockId: "child-text",
      parentTaskId: null,
      kind: "wakeup",
      scheduledFor: 1,
    };
    const items = [wake, command("task-1", "child-text", null)];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
  });

  it("counts two items with the same taskId once", () => {
    const items = [
      command("task-1", "child-text", null),
      command("task-1", "child-text", null),
    ];
    expect(subagentOwnedBackgroundItemCount(nestedCard(), items)).toBe(1);
  });
});
