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

type TodoSegmentModel = Extract<MessageSegment, { kind: "todo" }>;
type ToolSegmentModel = Extract<MessageSegment, { kind: "tool" }>;

interface DerivedPinnedTodo {
  readonly todo: PinnedTodoSnapshot | null;
  readonly suppressTaskTools: boolean;
}

/**
 * Derives the pinned todo snapshot from the rendered rows and strips the
 * inline todo/task-tool segments out of them (the pinned stack renders the
 * snapshot instead). The rows are the FULL chat history - Virtuoso windows
 * the mounted DOM, not the data - so a todo created in an old turn is always
 * in the walk.
 */
export function buildPinnedTodoRenderState(
  messages: ReadonlyArray<ChatMessageModel>,
): PinnedTodoRenderState {
  const derived = derivePinnedTodo(messages);
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
