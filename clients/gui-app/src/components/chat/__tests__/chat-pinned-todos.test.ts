import { describe, expect, it } from "vitest";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
  SegmentTodoItem,
} from "@/stores/composer/chat-store";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import {
  isTaskTodoToolName,
  parseTaskTodoToolPayloads,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";

// Mirror the host accumulator: raw input is not persisted, so a tool segment
// carries precomputed display fields - including the parsed task-todo items the
// pinned-todo stack now reads straight off the segment.
function toolInputFields(toolName: string, input: unknown) {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
    taskTodoItems: isTaskTodoToolName(toolName)
      ? parseTaskTodoToolPayloads({ toolName, payloads: [input] })
      : null,
  };
}

// The rendered rows are the FULL chat history, so `buildPinnedTodoRenderState`
// both DERIVES the pinned snapshot (latest-todo selection, task-tool parsing,
// the reset-after-user rule) and STRIPS the inline todo/task-tool segments
// that the pinned stack replaces.
describe("buildPinnedTodoRenderState", () => {
  describe("snapshot derivation", () => {
    it("pins the latest non-empty todo segment", () => {
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "turn-1",
          [todoSegment("todo-old", [todoItem("old", "pending")])],
          null,
        ),
        makeAssistantMessage(
          "turn-2",
          [
            todoSegment("todo-mid", [todoItem("mid", "pending")]),
            todoSegment("todo-new", [todoItem("new", "in_progress")]),
          ],
          null,
        ),
      ]);

      expect(state.todo?.id).toBe("todo-new");
      expect(state.todo?.items.map((item) => item.text)).toEqual(["new"]);
    });

    it("ignores empty todo segments", () => {
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage("turn-1", [todoSegment("todo-empty", [])], null),
      ]);

      expect(state.todo).toBeNull();
    });

    it("builds a fallback pinned todo list from task tool calls", () => {
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "turn-1",
          [
            toolSegment("task-create-1", "TaskCreate", {
              subject: "Add docstrings to PlatformRatings.jsx",
              description: "Add JSDoc docstrings",
              activeForm: "Adding docstrings to PlatformRatings.jsx",
            }),
          ],
          null,
        ),
        makeAssistantMessage(
          "turn-2",
          [
            toolSegment("task-create-2", "TaskCreate", {
              subject: "Add structured error logging",
              activeForm: "Adding structured error logging",
            }),
          ],
          null,
        ),
      ]);

      expect(state.todo?.id).toBe("task-create-2:task-todo");
      expect(state.todo?.items).toMatchObject([
        {
          text: "Add docstrings to PlatformRatings.jsx",
          status: "pending",
          activeForm: "Adding docstrings to PlatformRatings.jsx",
        },
        {
          text: "Add structured error logging",
          status: "pending",
        },
      ]);
    });

    it("uses semantic todo state over task tools within the same turn", () => {
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "turn-1",
          [
            todoSegment("todo-1", [
              todoItem("First task", "completed"),
              todoItem("Second task", "pending"),
            ]),
            toolSegment("task-update-2", "TaskUpdate", {
              taskId: "2",
              status: "pending",
            }),
          ],
          null,
        ),
      ]);

      expect(state.todo?.id).toBe("todo-1");
      expect(state.todo?.items.map((item) => item.text)).toEqual([
        "First task",
        "Second task",
      ]);
    });

    it("uses a newer task-tool snapshot over an older semantic todo", () => {
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "turn-1",
          [todoSegment("todo-old", [todoItem("semantic", "completed")])],
          null,
        ),
        makeUserMessage("user-2", "next"),
        makeAssistantMessage(
          "turn-2",
          [
            toolSegment("task-create-newer", "TaskCreate", {
              subject: "Tool task",
              activeForm: "Working on tool task",
            }),
          ],
          null,
        ),
      ]);

      expect(state.todo?.id).toBe("task-create-newer:task-todo");
      expect(state.todo?.items).toMatchObject([
        { text: "Tool task", status: "pending" },
      ]);
    });

    it("starts a replacement fallback task list after a new user message", () => {
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "turn-1",
          [
            toolSegment("task-create-old", "TaskCreate", {
              subject: "Old task",
            }),
          ],
          null,
        ),
        makeUserMessage("user-2", "next"),
        makeAssistantMessage(
          "turn-2",
          [
            toolSegment("task-create-new", "TaskCreate", {
              subject: "New task",
            }),
          ],
          null,
        ),
      ]);

      expect(state.todo?.id).toBe("task-create-new:task-todo");
      expect(state.todo?.items.map((item) => item.text)).toEqual(["New task"]);
    });

    it("resets the fallback task list on steer rows (rendered as user rows)", () => {
      // A queue-steer interjection renders as a `role: "user"` row inside the
      // turn, so it triggers the same reset rule as a plain user send.
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "turn-1",
          [
            toolSegment("task-create-old", "TaskCreate", {
              subject: "Old task",
            }),
          ],
          null,
        ),
        makeUserMessage("steer:queue-1", "user-steer"),
        makeAssistantMessage(
          "turn-1:part:1",
          [
            toolSegment("task-create-new", "TaskCreate", {
              subject: "New task",
            }),
          ],
          null,
        ),
      ]);

      expect(state.todo?.id).toBe("task-create-new:task-todo");
      expect(state.todo?.items.map((item) => item.text)).toEqual(["New task"]);
    });
  });

  describe("segment stripping", () => {
    it("suppresses every inline todo while preserving unaffected references", () => {
      const plain = makeAssistantMessage(
        "plain",
        [textSegment("text-1")],
        null,
      );
      const mixed = makeAssistantMessage(
        "mixed",
        [
          todoSegment("todo-1", [todoItem("check", "pending")]),
          textSegment("text-2"),
        ],
        null,
      );
      const todoOnly = makeAssistantMessage(
        "todo-only",
        [todoSegment("todo-2", [todoItem("done", "completed")])],
        null,
      );
      const liveTodoOnly = makeAssistantMessage(
        "live-todo-only",
        [todoSegment("todo-live", [todoItem("running", "in_progress")])],
        "running",
      );

      const state = buildPinnedTodoRenderState([
        plain,
        mixed,
        todoOnly,
        liveTodoOnly,
      ]);

      expect(state.todo?.id).toBe("todo-live");
      expect(state.messages.map((message) => message.id)).toEqual([
        "plain",
        "mixed",
        "live-todo-only",
      ]);
      expect(state.messages[0]).toBe(plain);
      expect(state.messages[1]).not.toBe(mixed);
      expect(
        state.messages[1]?.segments.map((segment) => segment.kind),
      ).toEqual(["text"]);
      expect(state.messages[2]?.segments).toEqual([]);
    });

    it("keeps the original array when there are no todo segments", () => {
      const messages = [
        makeAssistantMessage("plain", [textSegment("text-1")], null),
      ];

      const state = buildPinnedTodoRenderState(messages);

      expect(state.messages).toBe(messages);
      expect(state.todo).toBeNull();
    });

    it("strips empty todo segments even with no pinned snapshot", () => {
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [todoSegment("todo-empty", [])],
          null,
        ),
      ];

      const state = buildPinnedTodoRenderState(messages);

      expect(state.todo).toBeNull();
      expect(state.messages).toEqual([]);
    });

    it("keeps task tools inline when there is no pinned snapshot", () => {
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            toolSegment("task-update-1", "TaskUpdate", {
              taskId: "missing",
              status: "completed",
            }),
          ],
          null,
        ),
      ];

      const state = buildPinnedTodoRenderState(messages);

      expect(state.todo).toBeNull();
      expect(state.messages).toBe(messages);
    });

    it("suppresses task-tool rows when a snapshot is pinned", () => {
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            textSegment("text-1"),
            toolSegment("task-list-1", "TaskList", {}),
            toolSegment("task-create-1", "TaskCreate", { subject: "A task" }),
          ],
          null,
        ),
        makeAssistantMessage(
          "assistant-2",
          [toolSegment("task-update-1", "TaskUpdate", { taskId: "1" })],
          null,
        ),
      ];

      const state = buildPinnedTodoRenderState(messages);

      expect(state.todo).not.toBeNull();
      expect(state.messages.map((message) => message.id)).toEqual([
        "assistant-1",
      ]);
      expect(
        state.messages[0]?.segments.map((segment) => segment.kind),
      ).toEqual(["text"]);
    });

    it("keeps non-task tools inline alongside a pinned snapshot", () => {
      const grepOnly = makeAssistantMessage(
        "assistant-2",
        [toolSegment("grep-1", "Grep", { pattern: "todo" })],
        null,
      );
      const state = buildPinnedTodoRenderState([
        makeAssistantMessage(
          "assistant-1",
          [todoSegment("todo-1", [todoItem("pinned", "in_progress")])],
          null,
        ),
        grepOnly,
      ]);

      expect(state.todo?.id).toBe("todo-1");
      expect(state.messages).toEqual([grepOnly]);
      expect(state.messages[0]).toBe(grepOnly);
    });
  });
});

function makeAssistantMessage(
  id: string,
  segments: ReadonlyArray<MessageSegment>,
  runState: ChatMessageModel["runState"],
): ChatMessageModel {
  return {
    id,
    role: "assistant",
    content: "",
    segments,
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    runState,
    agentSenderInfo: null,
    agentMessage: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function makeUserMessage(id: string, content: string): ChatMessageModel {
  return {
    id,
    role: "user",
    content,
    segments: [
      {
        id: `${id}:text`,
        kind: "text",
        markdown: content,
        isStreaming: false,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    runState: null,
    agentSenderInfo: null,
    agentMessage: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function textSegment(id: string): MessageSegment {
  return {
    id,
    kind: "text",
    markdown: "Done",
    isStreaming: false,
  };
}

function todoSegment(
  id: string,
  items: ReadonlyArray<SegmentTodoItem>,
): MessageSegment {
  return {
    id,
    kind: "todo",
    items,
  };
}

function toolSegment(
  id: string,
  toolName: string,
  input: unknown,
): MessageSegment {
  return {
    id,
    kind: "tool",
    toolName,
    ...toolInputFields(toolName, input),
    error: null,
    agentMessageSend: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    startedAt: 0,
    durationMs: null,
    parentId: null,
  };
}

function todoItem(
  text: string,
  status: SegmentTodoItem["status"],
): SegmentTodoItem {
  return {
    id: `todo-${text}`,
    status,
    text,
    priority: null,
    activeForm: null,
  };
}
