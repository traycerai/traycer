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

/** Where {@link derivePinnedTodo} picks the accumulator up from. */
interface PinnedTodoFoldSeed {
  /** Task items already accumulated by whoever folded the prefix. */
  readonly taskItems: ReadonlyArray<SegmentTodoItem>;
  /** Whether a user row has been seen since the last `create`. */
  readonly resetOnFirstCreate: boolean;
}

/** The seed for a fold that starts at the beginning of the transcript. */
const EMPTY_PINNED_TODO_SEED: PinnedTodoFoldSeed = {
  taskItems: [],
  resetOnFirstCreate: false,
};

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
 * ## The overlay RESUMES the host's fold rather than restarting it
 *
 * The task tools are a delta protocol: an `update`/`complete`/`cancel` payload
 * carries an id and a status, not the task's text. Folded onto an empty state
 * those payloads name nothing and are dropped, so a turn that only advances
 * tasks created before the last snapshot used to produce no live todo at all -
 * and the dock sat on the host's baseline, showing the OLD statuses, for the
 * whole streaming turn. That is precisely the freeze this overlay exists to
 * prevent, and the legacy fold does not have it: running over the whole
 * history, it still holds the items those updates refer to.
 *
 * So the live fold starts from the host's items ({@link seedTaskTodoState}),
 * which is the same state the legacy fold would be carrying at this point in
 * the transcript.
 *
 * `resetOnFirstCreate` starts ARMED for the same reason. The rule is "the first
 * `create` after a user row", and the user row that started this turn is
 * outside the filtered subset by construction - only rows with a `runState`
 * survive it. Seeding without arming would merge a fresh turn's new checklist
 * into the previous one's; arming without seeding is today's behaviour. The two
 * together are what make the overlay agree with the legacy fold on both a
 * create-bearing turn and an update-only one.
 */
function hostAuthorityPinnedTodo(
  messages: ReadonlyArray<ChatMessageModel>,
  hostTodo: PinnedTodoSnapshot | null,
): DerivedPinnedTodo {
  const live = derivePinnedTodo(
    messages.filter((message) => message.runState !== null),
    {
      taskItems: hostTodo === null ? [] : hostTodo.items,
      resetOnFirstCreate: true,
    },
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
 *
 * `seed` is where the fold PICKS UP. A fold over the whole history starts at
 * {@link EMPTY_PINNED_TODO_SEED}; the windowed overlay resumes from the host's
 * answer - see {@link hostAuthorityPinnedTodo} for why both of its fields have
 * to move together.
 */
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
