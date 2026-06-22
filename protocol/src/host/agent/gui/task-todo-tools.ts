import type { RuntimeTodoItem, RuntimeTodoStatus } from "./agent-runtime";

export type TaskTodoAction =
  | "create"
  | "update"
  | "start"
  | "complete"
  | "cancel"
  | "list";

export interface ParsedTaskTodo {
  readonly id: string | null;
  readonly text: string | null;
  readonly status: RuntimeTodoStatus | null;
  readonly priority: string | null;
  readonly activeForm: string | null;
  readonly action: TaskTodoAction;
}

export interface TaskTodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: RuntimeTodoStatus;
  readonly priority: string | null;
  readonly activeForm: string | null;
}

export interface TaskTodoState {
  readonly taskTodoItemsById: Map<string, TaskTodoItem>;
  readonly taskTodoToolItemIds: Map<string, string>;
}

export interface TaskTodoToolPayloads {
  readonly toolName: string;
  readonly payloads: ReadonlyArray<unknown>;
}

const TASK_TODO_ACTION_BY_TOOL_NAME: ReadonlyMap<string, TaskTodoAction> =
  new Map([
    ["taskcreate", "create"],
    ["createtask", "create"],
    ["taskupdate", "update"],
    ["updatetask", "update"],
    ["taskstart", "start"],
    ["starttask", "start"],
    ["taskcomplete", "complete"],
    ["completetask", "complete"],
    ["taskfinish", "complete"],
    ["finishtask", "complete"],
    ["taskcancel", "cancel"],
    ["canceltask", "cancel"],
    ["taskcancelled", "cancel"],
    ["taskcanceled", "cancel"],
    ["tasklist", "list"],
    ["listtask", "list"],
    ["listtasks", "list"],
  ]);

const NUMERIC_TODO_STATUS = new Map<number, RuntimeTodoStatus>([
  [0, "pending"],
  [1, "in_progress"],
  [2, "completed"],
  [3, "cancelled"],
]);

const STRING_TODO_STATUS = new Map<string, RuntimeTodoStatus>([
  ["pending", "pending"],
  ["todo", "pending"],
  ["open", "pending"],
  ["not_started", "pending"],
  ["notstarted", "pending"],
  ["in_progress", "in_progress"],
  ["inprogress", "in_progress"],
  ["active", "in_progress"],
  ["running", "in_progress"],
  ["started", "in_progress"],
  ["completed", "completed"],
  ["complete", "completed"],
  ["done", "completed"],
  ["success", "completed"],
  ["succeeded", "completed"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
  ["cancel", "cancelled"],
  ["skipped", "cancelled"],
]);

export function taskTodoActionFromToolName(
  toolName: string,
): TaskTodoAction | null {
  return (
    TASK_TODO_ACTION_BY_TOOL_NAME.get(normalizeTaskTodoToolName(toolName)) ??
    null
  );
}

export function isTaskTodoToolName(toolName: string): boolean {
  return taskTodoActionFromToolName(toolName) !== null;
}

export function parseTaskTodoToolPayloads(
  input: TaskTodoToolPayloads,
): ParsedTaskTodo[] {
  const action = taskTodoActionFromToolName(input.toolName);
  if (action === null) return [];

  const records = recordsFromPayloads(input.payloads);
  if (records.length === 0) return [];

  const taskList = taskTodoArrayFromRecords(records);
  if (taskList !== null) {
    return taskList.flatMap((value) => {
      const parsed = parseTaskTodoRecords(action, recordsForParsing([value]));
      return parsed === null ? [] : [parsed];
    });
  }

  const parsed = parseTaskTodoRecords(action, recordsForParsing(input.payloads));
  return parsed === null ? [] : [parsed];
}

export function taskTodoFallbackItemId(
  toolUseId: string,
  index: number,
): string {
  return index === 0
    ? `task-tool:${toolUseId}`
    : `task-tool:${toolUseId}:${index}`;
}

export function defaultStatusForTaskTodoAction(
  action: TaskTodoAction,
): RuntimeTodoStatus {
  return defaultStatusOverrideForTaskTodoAction(action) ?? "pending";
}

export function createTaskTodoState(): TaskTodoState {
  return {
    taskTodoItemsById: new Map(),
    taskTodoToolItemIds: new Map(),
  };
}

export function applyParsedTaskTodoItems(
  state: TaskTodoState,
  toolUseId: string,
  parsedItems: ReadonlyArray<ParsedTaskTodo>,
): TaskTodoItem[] {
  if (parsedItems.length === 0) {
    return Array.from(state.taskTodoItemsById.values());
  }

  if (parsedItems[0]?.action === "list") {
    state.taskTodoItemsById.clear();
    state.taskTodoToolItemIds.clear();
  }

  parsedItems.forEach((parsed, index) => {
    const previousId = state.taskTodoToolItemIds.get(toolUseId) ?? null;
    const existingByTool =
      previousId === null
        ? null
        : state.taskTodoItemsById.get(previousId) ?? null;
    const id =
      parsed.id ?? previousId ?? taskTodoFallbackItemId(toolUseId, index);
    const existing = state.taskTodoItemsById.get(id) ?? existingByTool;
    const text = parsed.text ?? existing?.text ?? null;
    if (text === null) return;

    if (previousId !== null && previousId !== id) {
      state.taskTodoItemsById.delete(previousId);
    }

    state.taskTodoItemsById.set(id, {
      id,
      text,
      status:
        parsed.status ??
        existing?.status ??
        defaultStatusForTaskTodoAction(parsed.action),
      priority: parsed.priority ?? existing?.priority ?? null,
      activeForm: parsed.activeForm ?? existing?.activeForm ?? null,
    });

    if (parsedItems.length === 1) {
      state.taskTodoToolItemIds.set(toolUseId, id);
    }
  });

  return Array.from(state.taskTodoItemsById.values());
}

export function runtimeTodoItemsFromTaskTodoItems(
  items: ReadonlyArray<TaskTodoItem>,
): RuntimeTodoItem[] {
  return items.map((item) => ({
    id: item.id,
    text: item.text,
    status: item.status,
    ...(item.priority === null ? {} : { priority: item.priority }),
    ...(item.activeForm === null ? {} : { activeForm: item.activeForm }),
  }));
}

function defaultStatusOverrideForTaskTodoAction(
  action: TaskTodoAction,
): RuntimeTodoStatus | null {
  switch (action) {
    case "start":
      return "in_progress";
    case "complete":
      return "completed";
    case "cancel":
      return "cancelled";
    case "create":
    case "update":
    case "list":
      return null;
  }
}

function parseTaskTodoRecords(
  action: TaskTodoAction,
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ParsedTaskTodo | null {
  if (records.length === 0) return null;
  return {
    id: readFirstScalarString(records, ["id", "taskId", "task_id"]),
    text: readFirstScalarString(records, [
      "subject",
      "content",
      "text",
      "description",
    ]),
    status:
      readFirstTodoStatus(records, ["status", "state"]) ??
      defaultStatusOverrideForTaskTodoAction(action),
    priority: readFirstScalarString(records, ["priority"]),
    activeForm: readFirstScalarString(records, ["activeForm", "active_form"]),
    action,
  };
}

function taskTodoArrayFromRecords(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyArray<unknown> | null {
  for (const record of records) {
    const tasks = arrayFieldFromRecord(record, "tasks");
    if (tasks !== null) return tasks;
    const todos = arrayFieldFromRecord(record, "todos");
    if (todos !== null) return todos;
  }
  return null;
}

function recordsForParsing(
  payloads: ReadonlyArray<unknown>,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const records = recordsFromPayloads(payloads);
  const taskRecords = records.flatMap((record) => {
    const taskRecord = recordFromValue(record.task);
    return taskRecord === null ? [] : [taskRecord];
  });
  return [...taskRecords, ...records];
}

function recordsFromPayloads(
  payloads: ReadonlyArray<unknown>,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return payloads.flatMap((payload) => {
    const record = recordFromValue(payload);
    return record === null ? [] : [record];
  });
}

function readFirstScalarString(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = scalarStringFromValue(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function readFirstTodoStatus(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  keys: ReadonlyArray<string>,
): RuntimeTodoStatus | null {
  for (const record of records) {
    for (const key of keys) {
      const status = todoStatusFromValue(record[key]);
      if (status !== null) return status;
    }
  }
  return null;
}

export function todoStatusFromValue(value: unknown): RuntimeTodoStatus | null {
  if (typeof value === "number") {
    return NUMERIC_TODO_STATUS.get(value) ?? null;
  }
  if (typeof value !== "string") return null;

  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return STRING_TODO_STATUS.get(normalized) ?? null;
}

function scalarStringFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function arrayFieldFromRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<unknown> | null {
  const value = record[key];
  return isUnknownArray(value) ? value : null;
}

function recordFromValue(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

function normalizeTaskTodoToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
}
