import { describe, it, expect } from "vitest";
import { accumulateEvent } from "../agent-runtime-accumulator";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";

type SubAgentBlock = Extract<ContentBlock, { type: "subagent" }>;

describe("accumulateEvent parentBlockId preservation", () => {
  it("text.delta on a new block carries the event's parentBlockId", () => {
    const blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "hi",
      parentBlockId: "sub-1",
    });
    expect(blocks[0].parentBlockId).toBe("sub-1");
  });

  it("text.delta append keeps the first parent and does not erase it when omitted", () => {
    let blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "a",
      parentBlockId: "sub-1",
    });
    blocks = accumulateEvent(blocks, {
      type: "text.delta",
      blockId: "t1",
      timestamp: 2,
      delta: "b",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parentBlockId).toBe("sub-1");
    expect(blocks[0].type === "text" && blocks[0].text).toBe("ab");
  });

  it("text.delta without a parent creates a top-level block", () => {
    const blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "a",
    });
    expect(blocks[0].parentBlockId ?? null).toBeNull();
  });

  it("reasoning.delta on a new block carries the event's parentBlockId", () => {
    const blocks = accumulateEvent([], {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 1,
      delta: "think",
      parentBlockId: "sub-1",
    });
    expect(blocks[0].parentBlockId).toBe("sub-1");
  });

  it("reasoning.delta append keeps the first parent when later deltas omit it", () => {
    let blocks = accumulateEvent([], {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 1,
      delta: "a",
      parentBlockId: "sub-1",
    });
    blocks = accumulateEvent(blocks, {
      type: "reasoning.delta",
      blockId: "r1",
      timestamp: 2,
      delta: "b",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parentBlockId).toBe("sub-1");
    expect(blocks[0].type === "reasoning" && blocks[0].content).toBe("ab");
  });

  it("text.completed keeps the parent set by earlier deltas", () => {
    let blocks = accumulateEvent([], {
      type: "text.delta",
      blockId: "t1",
      timestamp: 1,
      delta: "a",
      parentBlockId: "sub-1",
    });
    blocks = accumulateEvent(blocks, {
      type: "text.completed",
      blockId: "t1",
      timestamp: 2,
    });
    expect(blocks[0].status).toBe("completed");
    expect(blocks[0].parentBlockId).toBe("sub-1");
  });
});

describe("accumulateEvent subagent.progress cap", () => {
  it("retains only the newest 50 progress updates, in order", () => {
    let blocks = accumulateEvent([], {
      type: "subagent.started",
      blockId: "sa1",
      timestamp: 1,
      name: "worker",
    });
    for (let i = 0; i < 60; i++) {
      blocks = accumulateEvent(blocks, {
        type: "subagent.progress",
        blockId: "sa1",
        timestamp: 2 + i,
        update: `u${i}`,
      });
    }
    const block = blocks[0] as SubAgentBlock;
    expect(block.progressUpdates).toHaveLength(50);
    expect(block.progressUpdates).toEqual(
      Array.from({ length: 50 }, (_, k) => `u${k + 10}`),
    );
  });
});
