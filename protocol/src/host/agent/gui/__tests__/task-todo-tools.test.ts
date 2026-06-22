import { describe, expect, it } from "vitest";
import {
  applyParsedTaskTodoItems,
  createTaskTodoState,
  defaultStatusForTaskTodoAction,
  isTaskTodoToolName,
  parseTaskTodoToolPayloads,
  runtimeTodoItemsFromTaskTodoItems,
  taskTodoFallbackItemId,
} from "../task-todo-tools";

describe("task todo tool helpers", () => {
  it("recognizes task tool name variants", () => {
    expect(isTaskTodoToolName("TaskCreate")).toBe(true);
    expect(isTaskTodoToolName("create_task")).toBe(true);
    expect(isTaskTodoToolName("TaskList")).toBe(true);
    expect(isTaskTodoToolName("Read")).toBe(false);
  });

  it("parses task lists and status aliases", () => {
    expect(
      parseTaskTodoToolPayloads({
        toolName: "TaskList",
        payloads: [
          {
            tasks: [
              {
                id: 1,
                subject: "Inspect changes",
                state: "started",
              },
              {
                task: {
                  task_id: "two",
                  content: "Write tests",
                  status: 2,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "1",
        text: "Inspect changes",
        status: "in_progress",
        priority: null,
        activeForm: null,
        action: "list",
      },
      {
        id: "two",
        text: "Write tests",
        status: "completed",
        priority: null,
        activeForm: null,
        action: "list",
      },
    ]);
  });

  it("prefers nested task identity while preserving input metadata", () => {
    expect(
      parseTaskTodoToolPayloads({
        toolName: "TaskCreate",
        payloads: [
          {
            task: {
              id: "created",
              subject: "Fix interview UI",
            },
          },
          {
            subject: "Fallback subject",
            activeForm: "Fixing interview UI",
          },
        ],
      }),
    ).toEqual([
      {
        id: "created",
        text: "Fix interview UI",
        status: null,
        priority: null,
        activeForm: "Fixing interview UI",
        action: "create",
      },
    ]);
  });

  it("keeps fallback ids and default action statuses centralized", () => {
    expect(taskTodoFallbackItemId("tool-1", 0)).toBe("task-tool:tool-1");
    expect(taskTodoFallbackItemId("tool-1", 2)).toBe("task-tool:tool-1:2");
    expect(defaultStatusForTaskTodoAction("start")).toBe("in_progress");
    expect(defaultStatusForTaskTodoAction("complete")).toBe("completed");
    expect(defaultStatusForTaskTodoAction("create")).toBe("pending");
  });

  it("reduces task tool snapshots with stable tool correlations", () => {
    const state = createTaskTodoState();

    expect(
      applyParsedTaskTodoItems(state, "tool-1", [
        {
          id: null,
          text: "Fix interview UI",
          status: null,
          priority: null,
          activeForm: "Fixing interview UI",
          action: "create",
        },
      ]),
    ).toEqual([
      {
        id: "task-tool:tool-1",
        text: "Fix interview UI",
        status: "pending",
        priority: null,
        activeForm: "Fixing interview UI",
      },
    ]);

    const updated = applyParsedTaskTodoItems(state, "tool-1", [
      {
        id: "p1",
        text: null,
        status: "completed",
        priority: "high",
        activeForm: null,
        action: "update",
      },
    ]);

    expect(updated).toEqual([
      {
        id: "p1",
        text: "Fix interview UI",
        status: "completed",
        priority: "high",
        activeForm: "Fixing interview UI",
      },
    ]);
    expect(runtimeTodoItemsFromTaskTodoItems(updated)).toEqual([
      {
        id: "p1",
        text: "Fix interview UI",
        status: "completed",
        priority: "high",
        activeForm: "Fixing interview UI",
      },
    ]);
  });
});
