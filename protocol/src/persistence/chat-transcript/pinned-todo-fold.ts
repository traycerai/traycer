import type {
  PinnedTodoItem,
  PinnedTodoSnapshot,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  applyParsedTaskTodoItems,
  createTaskTodoState,
  isTaskTodoToolName,
  type ParsedTaskTodo,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";
import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type {
  ContentBlock,
  Message,
  TodoBlock,
} from "@traycer/protocol/persistence/epic/schemas";

/**
 * The pinned-todo fold is a HOST derivation - a windowed client cannot run it, because it is a stateful accumulator with a reset rule keyed on user rows and a window would show the todos of whatever turn it happens to.
 * The corpus was silently unrunnable in the repo that owns it.
 */

/**
 * The todo stack the chat pins above its scrollback.
 * A STATEFUL accumulator with a reset rule keyed on user rows, so it cannot be evaluated over a window: a client holding only the tail would show whatever turn it happens to have hydrated.
 */

function pinnedTodoItemsFromBlock(block: TodoBlock): PinnedTodoItem[] {
  // The renderer's `todoItemsFromBlock` synthesis, verbatim: a persisted todo item's id is nullable and the pinned stack's is not, so an item without one is keyed by its position in the block.
  return block.items.map((item, index) => ({
    id: item.id ?? `${block.blockId}:item:${index}`,
    status: item.status,
    text: item.text,
    priority: item.priority,
    activeForm: item.activeForm,
  }));
}

/** Every assistant block in the transcript, by id. */
export function contentBlocksById(
  messages: readonly Message[],
): ReadonlyMap<string, ContentBlock> {
  const blocks = new Map<string, ContentBlock>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) blocks.set(block.blockId, block);
  }
  return blocks;
}

/** What a whole-transcript pinned-todo fold ends holding. */
export interface PinnedTodoFoldResult {
  /**
   * The live pinned todo, or `null` when the fold found none - which is the
   * ordinary state for most chats.
   */
  readonly todo: PinnedTodoSnapshot | null;
  /**
   * The task-tool accumulator as of the end of the fold, whether or not `todo`
   * came from it. Empty when the transcript used no task tools.
   */
  readonly taskItems: readonly PinnedTodoItem[];
}

/** Fold a whole transcript to its pinned todo and its task accumulator. */
export function foldPinnedTodo(
  rows: readonly TranscriptRowDescriptor[],
  blocksById: ReadonlyMap<string, ContentBlock>,
): PinnedTodoFoldResult {
  let taskTodoState = createTaskTodoState();
  let latestTodo: PinnedTodoSnapshot | null = null;
  let resetTaskItemsOnNextCreate = false;

  for (const row of rows) {
    const { source } = row;
    // A steer renders as a user row (`row-skeleton`'s `rowRole` agrees), so it
    // arms the reset exactly as a top-level user record does.
    if (source.kind === "user" || source.kind === "steer") {
      resetTaskItemsOnNextCreate = true;
      continue;
    }
    // Every other row kind (stopped turn, fork link, notification anchor,
    // setup card) renders no blocks of its own, so it can carry no todo.
    if (source.kind !== "assistant-slice") continue;

    let latestSemanticTodo: PinnedTodoSnapshot | null = null;
    let latestTaskTodo: PinnedTodoSnapshot | null = null;
    for (const blockId of source.blockIds) {
      const block = blocksById.get(blockId);
      if (block === undefined) continue;
      if (block.type === "todo") {
        if (block.items.length === 0) continue;
        latestSemanticTodo = {
          id: block.blockId,
          items: pinnedTodoItemsFromBlock(block),
        };
        continue;
      }
      if (block.type !== "tool_call") continue;
      if (!isTaskTodoToolName(block.toolName)) continue;

      // Parsed on the host at block-build time and persisted structured - the
      // raw tool input is not stored, so this is the only reading of it.
      const parsedItems: readonly ParsedTaskTodo[] = block.taskTodoItems ?? [];
      if (
        resetTaskItemsOnNextCreate &&
        parsedItems.some((parsed) => parsed.action === "create")
      ) {
        taskTodoState = createTaskTodoState();
        resetTaskItemsOnNextCreate = false;
      }
      const items = applyParsedTaskTodoItems(
        taskTodoState,
        block.blockId,
        parsedItems,
      );
      if (items.length === 0) continue;
      latestTaskTodo = { id: `${block.blockId}:task-todo`, items };
    }

    latestTodo = latestSemanticTodo ?? latestTaskTodo ?? latestTodo;
  }

  return {
    todo: latestTodo,
    // Read from the accumulator rather than from `latestTodo`, which is a
    // different thing whenever a semantic todo won the selection.
    taskItems: Array.from(taskTodoState.taskTodoItemsById.values()),
  };
}
