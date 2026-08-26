import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
  SegmentTodoItem,
} from "@/stores/composer/chat-store";
import {
  applyParsedTaskTodoItems,
  createTaskTodoState,
  isTaskTodoToolName,
  type ParsedTaskTodo,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";

export interface PinnedTodoSnapshot {
  readonly id: string;
  readonly items: ReadonlyArray<SegmentTodoItem>;
}

interface PinnedTodoRenderState {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly todo: PinnedTodoSnapshot | null;
}

/**
 * Who answers "which todo is pinned".
 *
 * `derive` is the legacy line: the rows are the whole history, so the fold
 * below can run over them. `host` is the windowed line: the fold is a
 * stateful accumulator with a reset rule keyed on user rows, so run over the
 * HYDRATED SUBSET it answers for whatever turns happen to be hydrated - a
 * live todo created outside the tail would vanish from the dock, reappear
 * while its span was hydrated, and vanish again on eviction. The host runs
 * the same fold over the full transcript and ships the result on every
 * snapshot (`ChatTranscriptDerived.pinnedTodo`); `todo: null` from it is the
 * real answer "no live todo", never "unknown".
 */
export type PinnedTodoAuthority =
  | { readonly kind: "derive" }
  | { readonly kind: "host"; readonly todo: PinnedTodoSnapshot | null };

type TodoSegmentModel = Extract<MessageSegment, { kind: "todo" }>;
type ToolSegmentModel = Extract<MessageSegment, { kind: "tool" }>;

interface DerivedPinnedTodo {
  readonly todo: PinnedTodoSnapshot | null;
  readonly suppressTaskTools: boolean;
}

/**
 * Resolves the pinned todo snapshot - from the rendered rows on the legacy
 * line, from the host's whole-transcript fold on the windowed one (see
 * {@link PinnedTodoAuthority}) - and strips the inline todo/task-tool
 * segments out of the rows (the pinned stack renders the snapshot instead).
 * The strip always runs over the rows this renderer HOLDS, whichever
 * authority named the todo: a hydrated task-tool row is suppressed by the
 * same rule either way.
 */
export function buildPinnedTodoRenderState(
  messages: ReadonlyArray<ChatMessageModel>,
  authority: PinnedTodoAuthority,
): PinnedTodoRenderState {
  const derived: DerivedPinnedTodo =
    authority.kind === "host"
      ? hostAuthorityPinnedTodo(messages, authority.todo)
      : derivePinnedTodo(messages);
  const filtered = messages
    .map((message) => {
      return filterTodoSegmentsFromMessage(message, derived.suppressTaskTools);
    })
    .filter((message): message is ChatMessageModel => message !== null);

  return {
    messages: filteredMessagesChanged(messages, filtered) ? filtered : messages,
    todo: derived.todo,
  };
}

function filteredMessagesChanged(
  messages: ReadonlyArray<ChatMessageModel>,
  filtered: ReadonlyArray<ChatMessageModel>,
): boolean {
  return (
    messages.length !== filtered.length ||
    filtered.some((message, index) => message !== messages[index])
  );
}

/**
 * The windowed line's todo: the host's whole-transcript answer, OVERLAID by
 * the live turn's own rows.
 *
 * The host baseline alone is not enough, because `derived` rides only
 * snapshot emits and those fire at turn BOUNDARIES - turn start, turn end, a
 * restore - never per tool call. Pinning to it verbatim would freeze the dock
 * for the whole streaming turn, which is exactly when a reader watches it.
 *
 * The overlay is ordering-correct where a fold over all hydrated rows is not:
 * a row still streaming (`runState !== null`) is built from deltas, so its
 * segments are a SUPERSET of whatever persisted state the host's last emit
 * folded - if the host's todo came from this turn, the live copy holds it
 * too, and anything the live copy adds is strictly newer. A fold over all
 * hydrated rows has no such order: an old span's todo would outrank a newer
 * one the host found in an unhydrated region.
 *
 * The accumulator's user-row reset needs no seeding here: the live rows start
 * the fold on an empty task state, which is what the reset would produce, and
 * an update-only turn that yields no items falls back to the baseline rather
 * than pinning a fragment.
 */
function hostAuthorityPinnedTodo(
  messages: ReadonlyArray<ChatMessageModel>,
  hostTodo: PinnedTodoSnapshot | null,
): DerivedPinnedTodo {
  const live = derivePinnedTodo(
    messages.filter((message) => message.runState !== null),
  );
  const todo = live.todo ?? hostTodo;
  return { todo, suppressTaskTools: todo !== null };
}

/**
 * Latest-todo selection over the rendered rows:
 *  - semantic `todo` segments pin as-is (newest non-empty wins),
 *  - task-todo `tool_call` segments fold into an accumulated task list via
 *    the protocol parse/apply helpers (id `` `${segment.id}:task-todo` ``),
 *  - a semantic todo outranks the task list within the same message,
 *  - the accumulated task items reset on the first `create` after a user row
 *    (steer interjections render as user rows, so they reset too).
 */
function derivePinnedTodo(
  messages: ReadonlyArray<ChatMessageModel>,
): DerivedPinnedTodo {
  let taskTodoState = createTaskTodoState();
  let latestTodo: PinnedTodoSnapshot | null = null;
  let resetTaskItemsOnNextCreate = false;

  for (const message of messages) {
    if (message.role === "user") {
      resetTaskItemsOnNextCreate = true;
    }

    let latestSemanticTodo: PinnedTodoSnapshot | null = null;
    let latestTaskTodo: PinnedTodoSnapshot | null = null;
    for (const segment of message.segments) {
      if (isTodoSegment(segment)) {
        if (segment.items.length === 0) continue;
        latestSemanticTodo = { id: segment.id, items: segment.items };
        continue;
      }

      if (!isTaskTodoToolSegment(segment)) continue;

      const parsedItems = parseTaskTodoToolSegment(segment);
      if (
        parsedItems.some((parsed) => parsed.action === "create") &&
        resetTaskItemsOnNextCreate
      ) {
        taskTodoState = createTaskTodoState();
        resetTaskItemsOnNextCreate = false;
      }
      const items = applyParsedTaskTodoItems(
        taskTodoState,
        segment.id,
        parsedItems,
      );
      if (items.length === 0) continue;
      latestTaskTodo = {
        id: `${segment.id}:task-todo`,
        items,
      };
    }

    latestTodo = latestSemanticTodo ?? latestTaskTodo ?? latestTodo;
  }

  return {
    todo: latestTodo,
    // Task-tool rows stay inline while no snapshot is pinned (nothing
    // replaces them); semantic todo segments are always lifted out of the
    // flow.
    suppressTaskTools: latestTodo !== null,
  };
}

function filterTodoSegmentsFromMessage(
  message: ChatMessageModel,
  suppressTaskTools: boolean,
): ChatMessageModel | null {
  const hasSuppressedSegment = message.segments.some((segment) =>
    shouldSuppressSegment(segment, suppressTaskTools),
  );
  if (!hasSuppressedSegment) return message;

  const segments = message.segments.filter(
    (segment) => !shouldSuppressSegment(segment, suppressTaskTools),
  );
  if (
    message.role === "assistant" &&
    message.runState === null &&
    segments.length === 0
  ) {
    return null;
  }
  return { ...message, segments };
}

function isTodoSegment(segment: MessageSegment): segment is TodoSegmentModel {
  return segment.kind === "todo";
}

function isToolSegment(segment: MessageSegment): segment is ToolSegmentModel {
  return segment.kind === "tool";
}

function shouldSuppressSegment(
  segment: MessageSegment,
  suppressTaskTools: boolean,
): boolean {
  if (isTodoSegment(segment)) return true;
  return suppressTaskTools && isTaskTodoToolSegment(segment);
}

function isTaskTodoToolSegment(
  segment: MessageSegment,
): segment is ToolSegmentModel {
  return isToolSegment(segment) && isTaskTodoToolName(segment.toolName);
}

function parseTaskTodoToolSegment(
  segment: ToolSegmentModel,
): ReadonlyArray<ParsedTaskTodo> {
  // Task-todo items are parsed on the host at block-build time and persisted
  // structured (raw input is no longer stored); read them straight off the
  // segment. Null for non-task-todo tools (filtered out by the caller).
  return segment.taskTodoItems ?? [];
}
