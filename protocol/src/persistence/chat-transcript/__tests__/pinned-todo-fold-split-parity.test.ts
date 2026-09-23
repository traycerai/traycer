import { describe, expect, it } from "vitest";
import {
  contentBlocksById,
  foldPinnedTodo,
  foldPinnedTodoRows,
  pinnedTodoFoldResult,
  startPinnedTodoFold,
  type PinnedTodoFoldState,
} from "@traycer/protocol/persistence/chat-transcript/pinned-todo-fold";
import { EMPTY_ROW_CONTEXT } from "@traycer/protocol/persistence/chat-transcript/row-context";
import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  todoBlockSchema,
  toolCallBlockSchema,
  type ContentBlock,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * `foldPinnedTodoRows` continues a fold from a held state. The property that
 * makes a held checkpoint sound: folding the rows in ANY split, one piece at a
 * time from `startPinnedTodoFold()`, ends where `foldPinnedTodo` over all of
 * them at once ends - and a held state is never mutated by a continuation.
 */

function todoBlock(
  blockId: string,
  items: ReadonlyArray<{ id: string | null; text: string; status: string }>,
): ContentBlock {
  return todoBlockSchema.parse({
    type: "todo",
    blockId,
    status: "completed",
    timestamp: 1,
    items: items.map((item) => ({
      ...item,
      priority: null,
      activeForm: null,
    })),
  });
}

function taskCall(
  blockId: string,
  toolName: string,
  parsed: ReadonlyArray<{
    id: string | null;
    text: string | null;
    status: string | null;
    action: string;
  }>,
): ContentBlock {
  return toolCallBlockSchema.parse({
    type: "tool_call",
    blockId,
    status: "completed",
    timestamp: 1,
    toolName,
    error: null,
    taskTodoItems: parsed.map((item) => ({
      ...item,
      priority: null,
      activeForm: null,
    })),
  });
}

function otherToolCall(blockId: string): ContentBlock {
  return toolCallBlockSchema.parse({
    type: "tool_call",
    blockId,
    status: "completed",
    timestamp: 1,
    toolName: "Read",
    error: null,
  });
}

function userRow(messageId: string): TranscriptRowDescriptor {
  return {
    rowId: `user:${messageId}`,
    createdAt: 1,
    source: { kind: "user", messageId },
    context: EMPTY_ROW_CONTEXT,
  };
}

function steerRow(queueItemId: string): TranscriptRowDescriptor {
  return {
    rowId: `steer:${queueItemId}`,
    createdAt: 1,
    source: {
      kind: "steer",
      turnKey: "turn-x",
      messageIds: [],
      steeredMessageId: null,
      steeredMessageIds: [],
      blockId: `steer-block-${queueItemId}`,
      queueItemId,
    },
    context: EMPTY_ROW_CONTEXT,
  };
}

function sliceRow(
  id: string,
  blockIds: readonly string[],
): TranscriptRowDescriptor {
  return {
    rowId: `assistant:${id}`,
    createdAt: 1,
    source: {
      kind: "assistant-slice",
      turnKey: `turn-${id}`,
      messageIds: [`m-${id}`],
      blockIds,
      chunkIndex: 0,
      split: false,
      synthesizedBoundary: false,
      decoratingEventIds: [],
      steeredMessageIds: [],
    },
    context: EMPTY_ROW_CONTEXT,
  };
}

function assistantMessage(
  messageId: string,
  blocks: readonly ContentBlock[],
): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: null,
    timestamp: 1,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}

const blocks: readonly ContentBlock[] = [
  taskCall("tc-create-1", "TaskCreate", [
    { id: "t1", text: "write", status: null, action: "create" },
  ]),
  taskCall("tc-create-2", "TaskCreate", [
    { id: "t2", text: "test", status: null, action: "create" },
  ]),
  taskCall("tc-start-1", "TaskStart", [
    { id: "t1", text: null, status: null, action: "start" },
  ]),
  otherToolCall("tc-read"),
  todoBlock("todo-empty", []),
  todoBlock("todo-sem-1", [
    { id: "s1", text: "semantic a", status: "pending" },
    { id: null, text: "semantic b", status: "in_progress" },
  ]),
  taskCall("tc-complete-1", "TaskComplete", [
    { id: "t1", text: null, status: null, action: "complete" },
  ]),
  taskCall("tc-create-3", "TaskCreate", [
    { id: "t3", text: "after reset", status: null, action: "create" },
  ]),
  taskCall("tc-list", "TaskList", [
    { id: "t9", text: "listed", status: "pending", action: "list" },
  ]),
  todoBlock("todo-sem-2", [{ id: "s2", text: "semantic c", status: "pending" }]),
  taskCall("tc-update-3", "TaskUpdate", [
    { id: "t3", text: "renamed", status: "completed", action: "update" },
  ]),
];

const blocksById = contentBlocksById([assistantMessage("m-all", blocks)]);

const rows: readonly TranscriptRowDescriptor[] = [
  userRow("u1"),
  sliceRow("a", ["tc-create-1", "tc-create-2"]),
  sliceRow("b", ["tc-start-1", "tc-read"]),
  sliceRow("c", ["todo-empty", "missing-block"]),
  sliceRow("d", ["todo-sem-1", "tc-complete-1"]),
  userRow("u2"),
  sliceRow("e", ["tc-create-3"]),
  steerRow("q1"),
  sliceRow("f", ["tc-create-1"]),
  sliceRow("g", ["tc-list"]),
  sliceRow("h", ["todo-sem-2", "tc-update-3"]),
  userRow("u3"),
  sliceRow("i", ["tc-update-3"]),
];

function foldInPieces(
  pieces: ReadonlyArray<readonly TranscriptRowDescriptor[]>,
): PinnedTodoFoldState {
  let state = startPinnedTodoFold();
  for (const piece of pieces) {
    state = foldPinnedTodoRows(state, piece, blocksById);
  }
  return state;
}

function splitAt(
  all: readonly TranscriptRowDescriptor[],
  points: readonly number[],
): Array<readonly TranscriptRowDescriptor[]> {
  const sorted = [...points].sort((a, b) => a - b);
  const pieces: Array<readonly TranscriptRowDescriptor[]> = [];
  let from = 0;
  for (const point of sorted) {
    pieces.push(all.slice(from, point));
    from = point;
  }
  pieces.push(all.slice(from));
  return pieces;
}

/** mulberry32: a seeded generator so the "random" splits replay exactly. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function snapshot(state: PinnedTodoFoldState): unknown {
  return {
    taskTodoItemsById: Array.from(state.taskTodoState.taskTodoItemsById),
    taskTodoToolItemIds: Array.from(state.taskTodoState.taskTodoToolItemIds),
    latestTodo: structuredClone(state.latestTodo),
    resetTaskItemsOnNextCreate: state.resetTaskItemsOnNextCreate,
  };
}

describe("foldPinnedTodoRows: split parity", () => {
  it("the fixture folds to a non-trivial answer (the parity is not vacuous)", () => {
    const whole = foldPinnedTodo(rows, blocksById);
    expect(whole.todo).not.toBeNull();
    expect(whole.taskItems.length).toBeGreaterThan(0);
    expect(whole.todo?.id).toBe("tc-update-3:task-todo");
  });

  it("an empty fold answers null and no task items", () => {
    expect(foldPinnedTodo([], blocksById)).toEqual({
      todo: null,
      taskItems: [],
    });
  });

  it("every single split point equals the whole-transcript fold", () => {
    const whole = foldPinnedTodo(rows, blocksById);
    for (let point = 0; point <= rows.length; point += 1) {
      const state = foldInPieces(splitAt(rows, [point]));
      expect(pinnedTodoFoldResult(state)).toEqual(whole);
    }
  });

  it("row-at-a-time folding equals the whole-transcript fold", () => {
    const whole = foldPinnedTodo(rows, blocksById);
    const pieces = rows.map((row) => [row]);
    expect(pinnedTodoFoldResult(foldInPieces(pieces))).toEqual(whole);
  });

  it("every two-way split equals the whole-transcript fold", () => {
    const whole = foldPinnedTodo(rows, blocksById);
    for (let first = 0; first <= rows.length; first += 1) {
      for (let second = first; second <= rows.length; second += 1) {
        const state = foldInPieces(splitAt(rows, [first, second]));
        expect(pinnedTodoFoldResult(state)).toEqual(whole);
      }
    }
  });

  it("seeded random multi-way splits equal the whole-transcript fold, state included", () => {
    const whole = foldPinnedTodoRows(startPinnedTodoFold(), rows, blocksById);
    const wholeSnapshot = snapshot(whole);
    const random = seededRandom(20260923);
    for (let trial = 0; trial < 200; trial += 1) {
      const cuts = Math.floor(random() * 8);
      const points: number[] = [];
      for (let index = 0; index < cuts; index += 1) {
        points.push(Math.floor(random() * (rows.length + 1)));
      }
      const state = foldInPieces(splitAt(rows, points));
      expect(snapshot(state)).toEqual(wholeSnapshot);
    }
  });
});

describe("foldPinnedTodoRows: a held state is never mutated", () => {
  it("folding a held state twice with different continuations leaves it, and each result, independent", () => {
    const held = foldInPieces([rows.slice(0, 5)]);
    const heldBefore = snapshot(held);

    const continuationA = rows.slice(5, 9);
    const continuationB = [userRow("ub"), ...rows.slice(9)];

    const resultA = foldPinnedTodoRows(held, continuationA, blocksById);
    expect(snapshot(held)).toEqual(heldBefore);
    const resultAAfterA = snapshot(resultA);

    const resultB = foldPinnedTodoRows(held, continuationB, blocksById);
    expect(snapshot(held)).toEqual(heldBefore);
    // Folding B did not reach back into A's result.
    expect(snapshot(resultA)).toEqual(resultAAfterA);

    // Each equals a fresh fold of prefix + its own continuation.
    expect(snapshot(resultA)).toEqual(
      snapshot(foldInPieces([rows.slice(0, 5), continuationA])),
    );
    expect(snapshot(resultB)).toEqual(
      snapshot(foldInPieces([rows.slice(0, 5), continuationB])),
    );
    expect(snapshot(resultA)).not.toEqual(snapshot(resultB));

    // The result does not share its accumulator maps with the held state.
    expect(resultA.taskTodoState.taskTodoItemsById).not.toBe(
      held.taskTodoState.taskTodoItemsById,
    );
    expect(resultA.taskTodoState.taskTodoToolItemIds).not.toBe(
      held.taskTodoState.taskTodoToolItemIds,
    );
  });

  it("folding zero rows returns an equal but unshared state", () => {
    const held = foldInPieces([rows.slice(0, 4)]);
    const before = snapshot(held);
    const next = foldPinnedTodoRows(held, [], blocksById);
    expect(snapshot(next)).toEqual(before);
    expect(next.taskTodoState.taskTodoItemsById).not.toBe(
      held.taskTodoState.taskTodoItemsById,
    );
  });

  it("the start state is not consumed by a fold", () => {
    const start = startPinnedTodoFold();
    const before = snapshot(start);
    foldPinnedTodoRows(start, rows, blocksById);
    expect(snapshot(start)).toEqual(before);
  });
});
