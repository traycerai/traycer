import { describe, expect, it } from "vitest";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
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
      const state = buildPinnedTodoRenderState(
        [
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
        ],
        { kind: "derive" },
      );

      expect(state.todo?.id).toBe("todo-new");
      expect(state.todo?.items.map((item) => item.text)).toEqual(["new"]);
    });

    it("ignores empty todo segments", () => {
      const state = buildPinnedTodoRenderState(
        [makeAssistantMessage("turn-1", [todoSegment("todo-empty", [])], null)],
        { kind: "derive" },
      );

      expect(state.todo).toBeNull();
    });

    it("builds a fallback pinned todo list from task tool calls", () => {
      const state = buildPinnedTodoRenderState(
        [
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
        ],
        { kind: "derive" },
      );

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
      const state = buildPinnedTodoRenderState(
        [
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
        ],
        { kind: "derive" },
      );

      expect(state.todo?.id).toBe("todo-1");
      expect(state.todo?.items.map((item) => item.text)).toEqual([
        "First task",
        "Second task",
      ]);
    });

    it("uses a newer task-tool snapshot over an older semantic todo", () => {
      const state = buildPinnedTodoRenderState(
        [
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
        ],
        { kind: "derive" },
      );

      expect(state.todo?.id).toBe("task-create-newer:task-todo");
      expect(state.todo?.items).toMatchObject([
        { text: "Tool task", status: "pending" },
      ]);
    });

    it("starts a replacement fallback task list after a new user message", () => {
      const state = buildPinnedTodoRenderState(
        [
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
        ],
        { kind: "derive" },
      );

      expect(state.todo?.id).toBe("task-create-new:task-todo");
      expect(state.todo?.items.map((item) => item.text)).toEqual(["New task"]);
    });

    it("resets the fallback task list on steer rows (rendered as user rows)", () => {
      // A queue-steer interjection renders as a `role: "user"` row inside the
      // turn, so it triggers the same reset rule as a plain user send.
      const state = buildPinnedTodoRenderState(
        [
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
        ],
        { kind: "derive" },
      );

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

      const state = buildPinnedTodoRenderState(
        [plain, mixed, todoOnly, liveTodoOnly],
        { kind: "derive" },
      );

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

      const state = buildPinnedTodoRenderState(messages, { kind: "derive" });

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

      const state = buildPinnedTodoRenderState(messages, { kind: "derive" });

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

      const state = buildPinnedTodoRenderState(messages, { kind: "derive" });

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

      const state = buildPinnedTodoRenderState(messages, { kind: "derive" });

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
      const state = buildPinnedTodoRenderState(
        [
          makeAssistantMessage(
            "assistant-1",
            [todoSegment("todo-1", [todoItem("pinned", "in_progress")])],
            null,
          ),
          grepOnly,
        ],
        { kind: "derive" },
      );

      expect(state.todo?.id).toBe("todo-1");
      expect(state.messages).toEqual([grepOnly]);
      expect(state.messages[0]).toBe(grepOnly);
    });
  });

  describe("host authority (windowed line)", () => {
    it("over completed rows only, returns the host todo verbatim and strips task-tool segments, even though the local fold would find nothing", () => {
      // No semantic todo segment and no task-tool call in these messages, so
      // `derivePinnedTodo` would answer `null` - the host's snapshot is the
      // only reason a todo is pinned here.
      const messages = [
        makeAssistantMessage("assistant-1", [textSegment("text-1")], null),
        makeAssistantMessage(
          "assistant-2",
          [toolSegment("task-update-1", "TaskUpdate", { taskId: "1" })],
          null,
        ),
      ];
      const hostTodo: PinnedTodoSnapshot = {
        id: "host-todo-1",
        items: [todoItem("host task", "in_progress")],
      };

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        todo: hostTodo,
        // The accumulator behind the host's selection. Here it IS that
        // selection's items; `a semantic todo does not seed the task fold`
        // below is the case where the two differ.
        taskItems: hostTodo.items,
        activeTurnId: null,
      });

      expect(state.todo).toBe(hostTodo);
      expect(state.messages.map((message) => message.id)).toEqual([
        "assistant-1",
      ]);
      expect(
        state.messages[0]?.segments.map((segment) => segment.kind),
      ).toEqual(["text"]);
    });

    it("over completed rows only, keeps task-tool segments inline when the host reports no todo, but still strips semantic todo segments", () => {
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            toolSegment("task-update-1", "TaskUpdate", { taskId: "1" }),
            todoSegment("todo-1", [todoItem("pinned", "pending")]),
          ],
          null,
        ),
      ];

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        todo: null,
        taskItems: [],
        activeTurnId: null,
      });

      expect(state.todo).toBeNull();
      const segment = state.messages[0]?.segments[0];
      expect(segment.kind).toBe("tool");
      expect(segment.kind === "tool" ? segment.toolName : undefined).toBe(
        "TaskUpdate",
      );
    });

    it("a live turn that only ADVANCES a host-known task still moves the dock", () => {
      // The task tools are a delta protocol: a `TaskComplete` carries the task
      // id and nothing else. Folded onto an empty state it names a task the
      // fold has never seen and is dropped, so the live fold produced no todo
      // at all and the dock sat on the host's baseline - showing `in_progress`
      // for a task the running turn had already finished - until the next
      // turn-boundary snapshot. Seeding the fold from the host's items is what
      // lets the delta land.
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            toolSegment("task-complete-live", "TaskComplete", {
              taskId: "todo-host task",
            }),
          ],
          "running",
        ),
      ];
      const hostTodo: PinnedTodoSnapshot = {
        id: "host-todo-1",
        items: [todoItem("host task", "in_progress")],
      };

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        todo: hostTodo,
        // The accumulator behind the host's selection. Here it IS that
        // selection's items; `a semantic todo does not seed the task fold`
        // below is the case where the two differ.
        taskItems: hostTodo.items,
        activeTurnId: null,
      });

      // The host's item, carried forward by id with the live status applied -
      // NOT the stale baseline, which is what `toBe(hostTodo)` would catch.
      expect(state.todo).not.toBe(hostTodo);
      expect(state.todo?.items).toEqual([
        {
          id: "todo-host task",
          text: "host task",
          status: "completed",
          priority: null,
          activeForm: null,
        },
      ]);
    });

    it("a semantic todo does not seed the task fold", () => {
      // The two halves of the host's fold are genuinely different lists, and
      // this is the case that proves the client must be told both.
      //
      // `foldPinnedTodo` lets a semantic `todo` block outrank the task list for
      // DISPLAY while the accumulator keeps running underneath it. So the
      // host's selected `pinnedTodo` here is the semantic checklist, and the
      // task item the live turn is about to complete is only in
      // `pinnedTaskTodoItems`.
      //
      // Seeding from the selection instead - the shape this store shipped
      // once - fails in one of two ways depending on the ids: the delta names
      // an item the seed does not hold and is dropped, or it collides with a
      // semantic item and rewrites THAT. Both leave the dock on a checklist
      // that is not the one the turn is advancing, which is worse than the
      // freeze the seeding exists to prevent.
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            toolSegment("task-complete-live", "TaskComplete", {
              taskId: "todo-tracked task",
            }),
          ],
          "running",
        ),
      ];

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        // What the dock was showing: a semantic todo, naming nothing the task
        // tools know about.
        todo: {
          id: "semantic-1",
          items: [todoItem("write the docs", "pending")],
        },
        // What the task deltas actually apply to.
        taskItems: [todoItem("tracked task", "in_progress")],
        activeTurnId: null,
      });

      expect(state.todo?.items).toEqual([
        {
          id: "todo-tracked task",
          text: "tracked task",
          status: "completed",
          priority: null,
          activeForm: null,
        },
      ]);
    });

    it("a live turn that CREATES replaces the host's list rather than merging into it", () => {
      // The seeded fold arms its reset for the same reason the whole-history
      // fold does: the user row that started this turn is outside the filtered
      // subset by construction, so the first `create` after it must clear the
      // seeded items. Without the arming, seeding would append the new
      // checklist to the previous turn's.
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            toolSegment("task-create-live", "TaskCreate", {
              id: "fresh-1",
              subject: "Fresh task",
            }),
          ],
          "running",
        ),
      ];

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        todo: {
          id: "host-todo-1",
          items: [todoItem("host task", "in_progress")],
        },
        taskItems: [todoItem("host task", "in_progress")],
        activeTurnId: null,
      });

      expect(state.todo?.items.map((item) => item.text)).toEqual([
        "Fresh task",
      ]);
    });

    it("a still-streaming row's own todo outranks the host's baseline", () => {
      // The live row is delta-built and therefore strictly fresher than
      // whatever the host's last snapshot emit folded - `runState` non-null
      // marks it as still streaming, and the overlay's fold runs over ONLY
      // those rows, ignoring the completed row entirely.
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [toolSegment("task-update-1", "TaskUpdate", { taskId: "1" })],
          null,
        ),
        makeAssistantMessage(
          "assistant-2",
          [
            toolSegment("task-create-live", "TaskCreate", {
              subject: "Live task",
            }),
          ],
          "running",
        ),
      ];
      const hostTodo: PinnedTodoSnapshot = {
        id: "host-todo-1",
        items: [todoItem("host task", "in_progress")],
      };

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        todo: hostTodo,
        // The accumulator behind the host's selection. Here it IS that
        // selection's items; `a semantic todo does not seed the task fold`
        // below is the case where the two differ.
        taskItems: hostTodo.items,
        activeTurnId: null,
      });

      expect(state.todo?.id).toBe("task-create-live:task-todo");
      expect(state.todo?.items.map((item) => item.text)).toEqual(["Live task"]);
      // Both task-tool segments are stripped (a todo is pinned). The completed
      // row (assistant-1) is left with no segments and is dropped entirely;
      // the still-streaming row (assistant-2) is kept even though it too ends
      // up empty, since only a COMPLETED empty assistant row is dropped.
      expect(state.messages.map((message) => message.id)).toEqual([
        "assistant-2",
      ]);
      expect(state.messages[0]?.segments).toEqual([]);
    });

    it("keeps a steer-split turn's PRE-STEER slice, which carries the create", () => {
      // The `activeTurnId` branch of `liveTurnSlice`, and the only thing that
      // reaches it: every other host-mode case here passes `activeTurnId: null`
      // and so decides membership on `runState` alone.
      //
      // A safe-point steer splits one turn across two rows and the renderer
      // puts `runState` on the TRAILING one only. When the task was created
      // before the steer, the `TaskCreate` is in the slice without it - so a
      // `runState`-only filter drops the create and the trailing `TaskUpdate`
      // then names a task the fold never heard of. Membership by turn key is
      // what keeps the pair together.
      const messages = [
        makeAssistantMessage(
          "assistant:turn-1:part:0",
          [
            toolSegment("task-create-pre-steer", "TaskCreate", {
              subject: "Split task",
            }),
          ],
          null,
        ),
        makeAssistantMessage(
          "assistant:turn-1:part:1",
          [
            toolSegment("task-update-live", "TaskUpdate", {
              taskId: "task-create-pre-steer",
              state: "in_progress",
            }),
          ],
          "running",
        ),
      ];
      const hostTodo: PinnedTodoSnapshot = {
        id: "host-todo-1",
        items: [todoItem("host task", "in_progress")],
      };

      const state = buildPinnedTodoRenderState(messages, {
        kind: "host",
        todo: hostTodo,
        taskItems: hostTodo.items,
        activeTurnId: "turn-1",
      });

      // The turn's OWN task, not the host's stale baseline: the create was
      // seen, so the fold has something for the update to land on.
      expect(state.todo?.items.map((item) => item.text)).toEqual([
        "Split task",
      ]);
    });

    it("derive-mode behaves as before over the same input (control)", () => {
      const messages = [
        makeAssistantMessage(
          "assistant-1",
          [
            toolSegment("task-update-1", "TaskUpdate", { taskId: "1" }),
            todoSegment("todo-1", [todoItem("pinned", "pending")]),
          ],
          null,
        ),
      ];

      const state = buildPinnedTodoRenderState(messages, { kind: "derive" });

      expect(state.todo?.id).toBe("todo-1");
      // Both segments are suppressed (the todo unconditionally, the task tool
      // because a snapshot is now pinned), leaving the assistant row empty -
      // and an empty completed assistant row is dropped entirely.
      expect(state.messages).toEqual([]);
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
    managedCommand: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    imageResults: [],
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
