import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
  SegmentTodoItem,
} from "@/stores/composer/chat-store";
import {
  applyParsedTaskTodoItems,
  createTaskTodoState,
  isTaskTodoToolName,
  seedTaskTodoState,
  type ParsedTaskTodo,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";
import { assistantRowTurnKey } from "@traycer/protocol/persistence/chat-transcript/row-projection";

export interface PinnedTodoSnapshot {
  readonly id: string;
  readonly items: ReadonlyArray<SegmentTodoItem>;
}

interface PinnedTodoRenderState {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly todo: PinnedTodoSnapshot | null;
}

/** `host` is the windowed line: the fold is a stateful accumulator with a reset rule keyed on user rows, so run over the HYDRATED SUBSET it answers for whatever turns happen to be hydrated - a live todo created outside the tail would vanish from the dock, reappear while its span was hydrated, and vanish again on eviction. The host runs the same fold over the full transcript and ships the result on every snapshot (`ChatTranscriptDerived.pinnedTodo`); `todo: null` from it is the real answer "no live todo", never "unknown". */
export type PinnedTodoAuthority =
  | { readonly kind: "derive" }
  | {
      readonly kind: "host";
      readonly todo: PinnedTodoSnapshot | null;
      /** The host fold's task accumulator - `ChatTranscriptDerived`'s `pinnedTaskTodoItems`, not `todo.items`. Separate because the fold keeps it separate: a semantic todo outranks the task list for DISPLAY without replacing it, so `todo` is regularly some other checklist entirely while this is the one the live turn's deltas address. */
      readonly taskItems: ReadonlyArray<SegmentTodoItem>;
      /** The running turn's key, or `null` when none is running. The LIVE-TURN MEMBERSHIP test - see {@link hostAuthorityPinnedTodo}. */
      readonly activeTurnId: string | null;
    };

type TodoSegmentModel = Extract<MessageSegment, { kind: "todo" }>;
type ToolSegmentModel = Extract<MessageSegment, { kind: "tool" }>;

interface DerivedPinnedTodo {
  readonly todo: PinnedTodoSnapshot | null;
  readonly suppressTaskTools: boolean;
}

/** Where {@link derivePinnedTodo} picks the accumulator up from. */
interface PinnedTodoFoldSeed {
  /** Task items already accumulated by whoever folded the prefix. */
  readonly taskItems: ReadonlyArray<SegmentTodoItem>;
  readonly resetOnFirstCreate: boolean;
}

/** The seed for a fold that starts at the beginning of the transcript. */
const EMPTY_PINNED_TODO_SEED: PinnedTodoFoldSeed = {
  taskItems: [],
  resetOnFirstCreate: false,
};

/** Resolves the pinned todo snapshot - from the rendered rows on the legacy line, from the host's whole-transcript fold on the windowed one (see {@link PinnedTodoAuthority}) - and strips the inline todo/task-tool segments out of the rows (the pinned stack renders the snapshot instead). The strip always runs over the rows this renderer HOLDS, whichever authority named the todo: a hydrated task-tool row is suppressed by the same rule either way. */
export function buildPinnedTodoRenderState(
  messages: ReadonlyArray<ChatMessageModel>,
  authority: PinnedTodoAuthority,
): PinnedTodoRenderState {
  const derived: DerivedPinnedTodo =
    authority.kind === "host"
      ? hostAuthorityPinnedTodo(
          messages,
          authority.todo,
          authority.taskItems,
          authority.activeTurnId,
        )
      : derivePinnedTodo(messages, EMPTY_PINNED_TODO_SEED);
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

/** Filtering on `runState` dropped it, so the trailing `TaskUpdate` looked for a task the seed had never heard of: the host's own seed predates the live tool call (derived snapshots update at turn boundaries), so nothing had it. Matched through `assistantRowTurnKey` rather than a local parse of the row id, for the reason the projection module keeps that helper exported: a second implementation of the id format is the drift it exists to prevent. */
function liveTurnSlice(
  message: ChatMessageModel,
  activeTurnId: string | null,
): boolean {
  if (activeTurnId === null) return message.runState !== null;
  // `runState` still counts on its own: the LIVE row is synthesized with the `assistant:live` id before the turn's real key is known, so a membership test alone would drop the very row the deltas are arriving on.
  if (message.runState !== null) return true;
  return assistantRowTurnKey(message.id) === activeTurnId;
}

/** The host baseline alone is not enough, because `derived` rides only snapshot emits and those fire at turn BOUNDARIES - turn start, turn end, a restore - never per tool call. The overlay RESUMES the host's fold rather than restarting it The task tools are a delta protocol: an `update`/`complete`/`cancel` payload carries an id and a status, not the task's text. */
function hostAuthorityPinnedTodo(
  messages: ReadonlyArray<ChatMessageModel>,
  hostTodo: PinnedTodoSnapshot | null,
  hostTaskItems: ReadonlyArray<SegmentTodoItem>,
  activeTurnId: string | null,
): DerivedPinnedTodo {
  const live = derivePinnedTodo(
    messages.filter((message) => liveTurnSlice(message, activeTurnId)),
    {
      taskItems: hostTaskItems,
      resetOnFirstCreate: true,
    },
  );
  const todo = live.todo ?? hostTodo;
  return { todo, suppressTaskTools: todo !== null };
}

/** Latest-todo selection over the rendered rows: - semantic `todo` segments pin as-is (newest non-empty wins), - task-todo `tool_call` segments fold into an accumulated task list via the protocol parse/apply helpers (id `` `${segment.id}:task-todo` ``), - a semantic todo outranks the task list within the same message, - the accumulated task items reset on the first `create` after a user row (steer interjections render as user rows, so they reset too). `seed` is where the fold PICKS UP. */
function derivePinnedTodo(
  messages: ReadonlyArray<ChatMessageModel>,
  seed: PinnedTodoFoldSeed,
): DerivedPinnedTodo {
  let taskTodoState = seedTaskTodoState(seed.taskItems);
  let latestTodo: PinnedTodoSnapshot | null = null;
  let resetTaskItemsOnNextCreate = seed.resetOnFirstCreate;

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
    // Task-tool rows stay inline while no snapshot is pinned (nothing replaces them); semantic todo segments are always lifted out of the flow.
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
  // Task-todo items are parsed on the host at block-build time and persisted structured (raw input is no longer stored); read them straight off the segment.
  // Null for non-task-todo tools (filtered out by the caller).
  return segment.taskTodoItems ?? [];
}
