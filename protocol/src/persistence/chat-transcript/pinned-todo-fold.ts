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
 * # Where this lives, and why it moved
 *
 * The pinned-todo fold is a HOST derivation - a windowed client cannot run it,
 * because it is a stateful accumulator with a reset rule keyed on user rows and
 * a window would show the todos of whatever turn it happens to hold. It lived
 * in `traycer-host/` first, for exactly that reason.
 *
 * It is here instead because of the CORPUS, not the caller. The renderer keeps
 * its own segment-walking fold until the segmentization extraction lands, so
 * two implementations exist and the only thing making that safe is a test that
 * runs both and asserts they agree. That test needs the renderer, so it lives
 * in `gui-app` - and a `gui-app` test cannot import from `traycer-host`, which
 * is a sibling checkout that does not exist in a standalone OSS clone. The
 * corpus was silently unrunnable in the repo that owns it.
 *
 * So the shared half moves down to the one package both sides can reach. Its
 * imports were already `@traycer/protocol` only, which is the tell that this is
 * where it belonged.
 *
 * A corpus that cannot run in the repo it lives in is not a corpus.
 */

/**
 * # The pinned-todo fold, host-side
 *
 * The todo stack the chat pins above its scrollback. A STATEFUL accumulator
 * with a reset rule keyed on user rows, so it cannot be evaluated over a
 * window: a client holding only the tail would show whatever turn it happens to
 * have hydrated. That is why the answer ships as a scalar on
 * `chatTranscriptDerived` and why the host has to run the fold.
 *
 * ## This mirrors `chat-pinned-todos.ts`, and that is a debt
 *
 * The renderer's copy (`clients/gui-app/src/components/chat/chat-pinned-todos.ts`)
 * folds over RENDERED rows and their message segments. The segmentization stack
 * that produces those segments is not shared code yet - extracting it is its
 * own ticket (see the live-host plan's §5 shared-derivation extraction) - so
 * this folds over the persisted records the segments are built from instead.
 *
 * The correspondence is exact rather than approximate, and the three places it
 * is load-bearing are called out at their use sites below: a `todo` segment IS
 * a `todo` block and its segment id IS `block.blockId`; a task-todo `tool`
 * segment IS a `tool_call` block whose `toolName` passes
 * {@link isTaskTodoToolName}, carrying its already-parsed `taskTodoItems`; and
 * a semantic todo item's id falls back to `` `${blockId}:item:${index}` ``,
 * which is the renderer's own synthesis in `todoItemsFromBlock`.
 *
 * When the segmentization extraction lands, this module should be deleted and
 * both sides should call the moved fold. Until then a change to the renderer's
 * fold has to be mirrored here, which is exactly the drift the extraction
 * exists to close.
 *
 * ## Why it walks ROWS rather than records
 *
 * The reset rule is "the first `create` after a user ROW", and a steer bubble
 * is a user row rendered from a block inside an ASSISTANT record - so a walk
 * over `chat.messages` would miss every steer reset. Walking
 * `projectTranscriptRows`'s output gets canonical order and the steer rows for
 * free, from the same enumeration the ordinals come from.
 */

function pinnedTodoItemsFromBlock(block: TodoBlock): PinnedTodoItem[] {
  // The renderer's `todoItemsFromBlock` synthesis, verbatim: a persisted todo
  // item's id is nullable and the pinned stack's is not, so an item without one
  // is keyed by its position in the block.
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

/**
 * What a whole-transcript pinned-todo fold ends holding.
 *
 * Two values, because the fold maintains two and the SELECTED one does not
 * determine the other. `todo` is what the dock shows; `taskItems` is the
 * task-tool accumulator, which keeps running underneath a semantic todo that
 * outranks it and is still what a later `update`/`complete` applies to.
 *
 * Both are needed to resume the fold, and only the pair is sound. A resumer
 * given `todo` alone has to guess: seeding the accumulator from a SEMANTIC
 * todo's items either drops the delta (its id is not in there) or, worse,
 * rewrites an unrelated semantic item that happens to collide - leaving the
 * checklist wrong rather than merely stale.
 */
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

/**
 * Fold a whole transcript to its pinned todo and its task accumulator.
 *
 * Latest-todo selection, matching the renderer's:
 *  - semantic `todo` blocks pin as-is (newest non-empty wins),
 *  - task-todo `tool_call` blocks fold into an accumulated list through the
 *    shared protocol helpers,
 *  - a semantic todo outranks the task list within the same row,
 *  - the accumulated task items reset on the first `create` after a user row.
 */
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
