import { describe, expect, it } from "vitest";
import {
  resolveAutoOpenTarget,
  type AutoOpenRecencyByNodeId,
  type AutoOpenRecord,
} from "@/lib/epic-auto-open";

const NO_RECENCY: AutoOpenRecencyByNodeId = {};

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

    const target = resolveAutoOpenTarget(records, "tui-1", null, NO_RECENCY);

    expect(target?.id).toBe("tui-1");
    expect(target?.type).toBe("terminal-agent");
  });

  it("does not substitute another chat when an explicit focus target is gone", () => {
    const records = [record({ id: "chat-1", name: "Chat One", type: "chat" })];

    const target = resolveAutoOpenTarget(records, "missing", null, NO_RECENCY);

    expect(target).toBeNull();
  });

  it("still selects the first openable node when no focus was requested", () => {
    const records = [record({ id: "chat-1", name: "Chat One", type: "chat" })];

    const target = resolveAutoOpenTarget(records, null, null, NO_RECENCY);

    expect(target?.id).toBe("chat-1");
  });

  it("lands on the most recently active chat rather than the oldest one", () => {
    const records = [
      record({ id: "chat-old", name: "Chat One", type: "chat" }),
      record({ id: "chat-new", name: "Chat Two", type: "chat" }),
    ];

    const target = resolveAutoOpenTarget(records, null, null, {
      "chat-old": 100,
      "chat-new": 200,
    });

    expect(target?.id).toBe("chat-new");
    expect(target?.name).toBe("Chat Two");
  });

  it("reaches a newer nested chat past a spec that heads the tree", () => {
    const records = [
      record({ id: "spec-1", name: "Spec", type: "spec" }),
      record({ id: "chat-old", name: "Chat One", type: "chat" }),
      record({
        id: "chat-new",
        parentId: "spec-1",
        name: "Chat Two",
        type: "chat",
      }),
    ];

    const target = resolveAutoOpenTarget(records, null, null, {
      "chat-old": 100,
      "chat-new": 200,
    });

    expect(target?.id).toBe("chat-new");
  });

  it("falls back to tree order when no openable node carries recency", () => {
    const records = [
      record({ id: "chat-1", name: "Chat One", type: "chat" }),
      record({ id: "chat-2", name: "Chat Two", type: "chat" }),
    ];

    // A recency stamp for a node that is not in the tree must not promote
    // anything, and must not suppress the tree-first fallback either.
    const target = resolveAutoOpenTarget(records, null, null, {
      "chat-elsewhere": 900,
    });

    expect(target?.id).toBe("chat-1");
  });

  it("breaks a recency tie in tree order", () => {
    const records = [
      record({ id: "chat-1", name: "Chat One", type: "chat" }),
      record({ id: "chat-2", name: "Chat Two", type: "chat" }),
    ];

    const target = resolveAutoOpenTarget(records, null, null, {
      "chat-1": 500,
      "chat-2": 500,
    });

    expect(target?.id).toBe("chat-1");
  });

  it("keeps an explicit focus target ahead of a newer chat", () => {
    const records = [
      record({ id: "chat-old", name: "Chat One", type: "chat" }),
      record({ id: "chat-new", name: "Chat Two", type: "chat" }),
    ];

    const target = resolveAutoOpenTarget(records, "chat-old", null, {
      "chat-old": 100,
      "chat-new": 200,
    });

    expect(target?.id).toBe("chat-old");
  });

  it("keeps this device's persisted focus ahead of a newer chat", () => {
    const records = [
      record({ id: "chat-old", name: "Chat One", type: "chat" }),
      record({ id: "chat-new", name: "Chat Two", type: "chat" }),
    ];

    const target = resolveAutoOpenTarget(records, null, "chat-old", {
      "chat-old": 100,
      "chat-new": 200,
    });

    expect(target?.id).toBe("chat-old");
  });

  it("ignores recency carried by a node that cannot be opened", () => {
    const records = [
      record({ id: "chat-1", name: "Chat One", type: "chat" }),
      record({ id: "terminal-1", name: "Terminal", type: "terminal" }),
    ];

    const target = resolveAutoOpenTarget(records, null, null, {
      "chat-1": 100,
      "terminal-1": 900,
    });

    expect(target?.id).toBe("chat-1");
  });
});
