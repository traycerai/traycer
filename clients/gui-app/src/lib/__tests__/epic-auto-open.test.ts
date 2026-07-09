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

  it("falls back to the first openable node when the focus id is unknown", () => {
    const records = [record({ id: "chat-1", name: "Chat One", type: "chat" })];

    const target = resolveAutoOpenTarget(records, "missing", null);

    expect(target?.id).toBe("chat-1");
  });
});
