import { describe, expect, it } from "vitest";
import {
  resolveAutoOpenTarget,
  type AutoOpenRecord,
} from "@/lib/epic-auto-open";

function record(over: Partial<AutoOpenRecord>): AutoOpenRecord {
  return {
    id: "node",
    parentId: null,
    name: "Node",
    type: "chat",
    hostId: "host-1",
    ...over,
  };
}

describe("resolveAutoOpenTarget", () => {
  it("focuses a terminal-agent (TUI agent) rather than an arbitrary chat", () => {
    const records = [
      record({ id: "chat-1", name: "Chat One", type: "chat" }),
      record({ id: "tui-1", name: "Claude", type: "terminal-agent" }),
    ];

    const target = resolveAutoOpenTarget(records, "tui-1", null);

    expect(target?.id).toBe("tui-1");
    expect(target?.type).toBe("terminal-agent");
  });

  it("does not substitute another chat when an explicit focus target is gone", () => {
    const records = [record({ id: "chat-1", name: "Chat One", type: "chat" })];

    const target = resolveAutoOpenTarget(records, "missing", null);

    expect(target).toBeNull();
  });

  it("still selects the first openable node when no focus was requested", () => {
    const records = [record({ id: "chat-1", name: "Chat One", type: "chat" })];

    const target = resolveAutoOpenTarget(records, null, null);

    expect(target?.id).toBe("chat-1");
  });
});
