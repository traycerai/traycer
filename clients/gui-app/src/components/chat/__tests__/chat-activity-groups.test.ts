import { describe, expect, it } from "vitest";
import {
  activityGroupSummary,
  buildChatActivityTimeline,
  latestActivityLabel,
} from "@/components/chat/chat-activity-groups";
import type { ChatActivityTimelineItem } from "@/components/chat/chat-activity-groups";
import type { MessageSegment } from "@/stores/composer/chat-store";
import type { AgentMessageSend } from "@traycer/protocol/persistence/epic/content-blocks";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import {
  isTaskTodoToolName,
  parseTaskTodoToolPayloads,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";

const EMPTY_PROMOTED_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

// Mirror the host accumulator: the raw input is not persisted, so a tool
// segment carries precomputed display fields. Computed via the same protocol
// helpers the host uses so the fixtures stay faithful.
function toolInputFields(toolName: string, input: unknown) {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
    taskTodoItems: isTaskTodoToolName(toolName)
      ? parseTaskTodoToolPayloads({ toolName, payloads: [input] })
      : null,
  };
}

describe("chat activity grouping", () => {
  it("groups operational runs between narrative text blocks", () => {
    const timeline = buildCompleteTimeline([
      textSegment("text-1", "First"),
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      commandSegment("command-1", "bun test", false),
      textSegment("text-2", "Second"),
      commandSegment("command-2", "git status", false),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "segment",
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("activity_group");
    if (timeline[1]?.kind !== "activity_group") {
      throw new Error("Expected first activity group");
    }
    expect(timeline[1].group.summary).toBe("Read 1 file, ran 1 command");
    expect(timeline[3]?.kind).toBe("activity_group");
    if (timeline[3]?.kind !== "activity_group") {
      throw new Error("Expected second activity group");
    }
    expect(timeline[3].group.summary).toBe("Ran 1 command");
  });

  it("groups leading, trailing, and single operational items", () => {
    const timeline = buildCompleteTimeline([
      commandSegment("command-1", "pwd", false),
      textSegment("text-1", "Done"),
      toolSegment("tool-1", "glob", { pattern: "src/**/*.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[0]?.kind).toBe("activity_group");
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected leading activity group");
    }
    expect(timeline[0].group.summary).toBe("Ran 1 command");
    expect(timeline[2]?.kind).toBe("activity_group");
    if (timeline[2]?.kind !== "activity_group") {
      throw new Error("Expected trailing activity group");
    }
    expect(timeline[2].group.summary).toBe("Explored 1 file");
  });

  it("keeps non-activity support segments out of activity groups", () => {
    const timeline = buildCompleteTimeline([
      commandSegment("command-1", "pwd", false),
      todoSegment("todo-1"),
      commandSegment("command-2", "ls", false),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
  });

  it("promotes reasoning to its own segment before operational activity", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false),
      commandSegment("command-1", "bun test", false),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "segment",
      "activity_group",
    ]);
    if (timeline[0]?.kind !== "segment") {
      throw new Error("Expected promoted reasoning segment");
    }
    expect(timeline[0].segment.kind).toBe("reasoning");
    if (timeline[1]?.kind !== "activity_group") {
      throw new Error("Expected operational activity group");
    }
    expect(timeline[1].group.summary).toBe("Ran 1 command");
    expect(timeline[1].group.segments.map((segment) => segment.kind)).toEqual([
      "command",
    ]);
  });

  it("promotes each reasoning block between operational phases", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false),
      commandSegment("command-1", "pwd", false),
      reasoningSegment("reasoning-2", false),
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "segment",
      "activity_group",
      "segment",
      "activity_group",
    ]);
    if (timeline[1]?.kind !== "activity_group") {
      throw new Error("Expected first activity group");
    }
    expect(timeline[1].group.summary).toBe("Ran 1 command");
    if (timeline[3]?.kind !== "activity_group") {
      throw new Error("Expected second activity group");
    }
    expect(timeline[3].group.summary).toBe("Read 1 file");
    expect(timeline[3].group.segments.map((segment) => segment.kind)).toEqual([
      "tool",
    ]);
  });

  it("renders consecutive reasoning blocks as standalone segments", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false),
      reasoningSegment("reasoning-2", false),
      textSegment("text-1", "Done"),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "segment",
      "segment",
      "segment",
    ]);
    expect(
      timeline.map((item) =>
        item.kind === "segment" ? item.segment.kind : item.kind,
      ),
    ).toEqual(["reasoning", "reasoning", "text"]);
  });

  it("keeps streaming activity active with a stable summary label", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      commandSegment("command-1", "bun test", true),
    ]);

    expect(timeline[0]?.kind).toBe("activity_group");
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    expect(timeline[0].group.isStreaming).toBe(true);
    expect(timeline[0].group.isActive).toBe(true);
    expect(timeline[0].group.label).toBe("Read 1 file, ran 1 command");
  });

  it("exposes the active child's start for the group elapsed heartbeat", () => {
    const streaming = buildCompleteTimeline([
      commandSegment("command-1", "bun test", true),
    ]);
    if (streaming[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    // A streaming tool/command anchors the header elapsed.
    expect(streaming[0].group.activeStartedAt).not.toBeNull();

    const done = buildCompleteTimeline([
      commandSegment("command-1", "bun test", false),
    ]);
    if (done[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    // Nothing in flight → no elapsed anchor.
    expect(done[0].group.activeStartedAt).toBeNull();
  });

  it("keeps the trailing activity group active while the assistant turn is live", () => {
    const timeline = buildActiveTimeline([
      fileChangeSegment("file-change-1", "/repo/src/app.ts", false),
    ]);

    expect(timeline[0]?.kind).toBe("activity_group");
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    expect(timeline[0].group.isStreaming).toBe(false);
    expect(timeline[0].group.isActive).toBe(true);
    expect(timeline[0].group.label).toBe("Edited 1 file");
  });

  it("does not reactivate earlier groups in a live assistant turn", () => {
    const timeline = buildActiveTimeline([
      fileChangeSegment("file-change-1", "/repo/src/app.ts", false),
      textSegment("text-1", "Done with that file."),
    ]);

    expect(timeline[0]?.kind).toBe("activity_group");
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    expect(timeline[0].group.isActive).toBe(false);
    expect(timeline[0].group.label).toBe("Edited 1 file");
  });

  it("promotes active subagents out of generic activity groups", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      subagentSegment("subagent-1", true),
      commandSegment("command-1", "bun test", false),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "promoted_subagent",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("promoted_subagent");
    if (timeline[1]?.kind !== "promoted_subagent") {
      throw new Error("Expected promoted subagent");
    }
    expect(timeline[1].segment.name).toBe("reviewer");
    const groups = timeline.filter(
      (
        item,
      ): item is Extract<
        (typeof timeline)[number],
        { kind: "activity_group" }
      > => item.kind === "activity_group",
    );
    expect(
      groups.flatMap((item) =>
        item.group.segments.map((segment) => segment.kind),
      ),
    ).not.toContain("subagent");
  });

  it("promotes running background command tools out of generic activity groups", () => {
    const bash = {
      ...toolSegment("tool-1", "Bash", {
        command: "sleep 60",
        run_in_background: true,
      }),
      // The accumulator stamps `backgroundTask` at birth from `run_in_background`;
      // that sticky marker - not the transient streaming state - is what keeps a
      // background command promoted while it runs.
      backgroundTask: true,
      isStreaming: true,
    };
    const timeline = buildCompleteTimeline([
      toolSegment("tool-0", "read_file", { path: "/repo/a.ts" }),
      bash,
      toolSegment("tool-2", "glob", { pattern: "src/**/*.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("segment");
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected promoted background command tool");
    }
    expect(timeline[1].segment.kind).toBe("tool");
    if (timeline[1].segment.kind !== "tool") {
      throw new Error("Expected promoted tool segment");
    }
    expect(timeline[1].segment.toolName).toBe("Bash");
  });

  it("promotes command tools that are completed locally but still backgrounded by the host", () => {
    const bash = toolSegment("tool-1", "Bash", {
      command: "sleep 60",
      run_in_background: true,
    });
    const timeline = buildCompleteTimelineWithPromoted(
      [
        toolSegment("tool-0", "read_file", { path: "/repo/a.ts" }),
        bash,
        toolSegment("tool-2", "glob", { pattern: "src/**/*.ts" }),
      ],
      new Set(["tool-1"]),
    );

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("segment");
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected live background command tool card");
    }
    expect(timeline[1].segment.kind).toBe("tool");
    if (timeline[1].segment.kind !== "tool") {
      throw new Error("Expected promoted tool segment");
    }
    expect(timeline[1].segment.id).toBe("tool-1");
  });

  it("keeps completed background command output promoted as a standalone card", () => {
    const bash = {
      ...toolSegment("tool-1", "Bash", {
        command: "sleep 1",
        run_in_background: true,
      }),
      backgroundOutput: {
        stdout: "done\n",
        stderr: "",
        truncated: false,
      },
    };
    const timeline = buildCompleteTimeline([
      toolSegment("tool-0", "read_file", { path: "/repo/a.ts" }),
      bash,
      toolSegment("tool-2", "glob", { pattern: "src/**/*.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("segment");
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected promoted completed background command tool");
    }
    expect(timeline[1].segment.kind).toBe("tool");
    if (timeline[1].segment.kind !== "tool") {
      throw new Error("Expected promoted tool segment");
    }
    expect(timeline[1].segment.backgroundOutput?.stdout).toBe("done\n");
  });

  it("keeps a completed background command promoted via the persistent marker (no live item, no output)", () => {
    // The exact recurring regression: at completion the host removes the live
    // background item, and several terminal paths set neither backgroundOutput
    // nor error. The persistent `backgroundTask` marker must keep the card a
    // standalone card so it never collapses back into the activity group.
    const bash = {
      ...toolSegment("tool-1", "Bash", {
        command: "sleep 60",
        run_in_background: true,
      }),
      backgroundTask: true,
    };
    const timeline = buildCompleteTimeline([
      toolSegment("tool-0", "read_file", { path: "/repo/a.ts" }),
      bash,
      toolSegment("tool-2", "glob", { pattern: "src/**/*.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("segment");
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected promoted completed background command card");
    }
    expect(timeline[1].segment.kind).toBe("tool");
    if (timeline[1].segment.kind !== "tool") {
      throw new Error("Expected promoted tool segment");
    }
    expect(timeline[1].segment.id).toBe("tool-1");
  });

  it("keeps errored background command tools promoted as standalone cards", () => {
    const bash = {
      ...toolSegment("tool-1", "Bash", {
        command: "sleep 60",
        run_in_background: true,
      }),
      // A backgrounded command that errors keeps its sticky `backgroundTask`
      // marker, so it stays a standalone card (an errored *foreground* command,
      // which has no marker, folds into the activity group instead).
      backgroundTask: true,
      error: "stopped: user requested stop",
      endState: null,
    };
    const timeline = buildCompleteTimeline([
      toolSegment("tool-0", "read_file", { path: "/repo/a.ts" }),
      bash,
      toolSegment("tool-2", "glob", { pattern: "src/**/*.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("segment");
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected promoted errored command tool");
    }
    expect(timeline[1].segment.kind).toBe("tool");
    if (timeline[1].segment.kind !== "tool") {
      throw new Error("Expected promoted tool segment");
    }
    expect(timeline[1].segment.error).toContain("stopped");
  });

  it("never promotes a foreground command tool - it folds into the activity group while streaming and after it completes or errors", () => {
    // Regression: a normal foreground command carries no `backgroundTask`
    // marker, never lands in `promotedToolBlockIds`, and captures no
    // `backgroundOutput`. It must stay inside the activity group through its
    // whole life - it must not flash into a standalone card while it runs and
    // collapse back on completion.
    const streamingForeground = {
      ...toolSegment("tool-1", "Bash", { command: "ls" }),
      isStreaming: true,
    };
    const erroredForeground = {
      ...toolSegment("tool-2", "Bash", { command: "false" }),
      error: "command failed",
    };
    const timeline = buildActiveTimeline([
      toolSegment("tool-0", "read_file", { path: "/repo/a.ts" }),
      streamingForeground,
      erroredForeground,
    ]);

    expect(timeline.map((item) => item.kind)).toEqual(["activity_group"]);
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected a single activity group");
    }
    expect(timeline[0].group.segments.map((segment) => segment.id)).toEqual([
      "tool-0",
      "tool-1",
      "tool-2",
    ]);
  });

  it("keeps completed subagents as promoted standalone items", () => {
    const timeline = buildCompleteTimeline([
      subagentSegment("subagent-1", false),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("promoted_subagent");
    if (timeline[0]?.kind !== "promoted_subagent") {
      throw new Error("Expected promoted subagent");
    }
    expect(timeline[0].segment.result).toBe("Found the issue.");
  });

  it("preserves chronological order for multiple promoted subagents", () => {
    const timeline = buildCompleteTimeline([
      subagentSegment("subagent-1", true),
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      subagentSegment("subagent-2", true),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "promoted_subagent",
      "activity_group",
      "promoted_subagent",
    ]);
    expect(timeline[0]?.id).toBe("promoted:subagent-1");
    expect(timeline[2]?.id).toBe("promoted:subagent-2");
  });

  it("promotes A2A send-message tools out of generic activity groups", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      a2aToolSegment("tool-2", "traycer_a2a/traycer_send_message", {
        receiverAgentId: "agent-receiver-1",
        message: "Please inspect the failure.",
        responseId: "response-1",
        expectReply: true,
      }),
      commandSegment("command-1", "bun test", false),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(timeline[1]?.kind).toBe("segment");
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected promoted A2A tool segment");
    }
    expect(timeline[1].segment.kind).toBe("tool");
    if (timeline[1].segment.kind !== "tool") {
      throw new Error("Expected tool segment");
    }
    expect(timeline[1].segment.toolName).toBe(
      "traycer_a2a/traycer_send_message",
    );
  });

  it("renders matched interviews as answered-question items and suppresses the raw question tool", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "question", {
        questions: [{ question: "Where?", options: [] }],
      }),
      interviewSegment("tool-1:interview"),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("answered_questions");
    if (timeline[0]?.kind !== "answered_questions") {
      throw new Error("Expected answered questions item");
    }
    expect(timeline[0].summary).toBe("Answered 1 question");
  });

  it("summarizes partially answered interviews by answered and total counts", () => {
    const timeline = buildCompleteTimeline([
      {
        ...interviewSegment("tool-1:interview"),
        questions: [
          {
            questionId: "q1",
            question: "Where?",
            header: null,
            options: [],
            multiSelect: false,
          },
          {
            questionId: "q2",
            question: "Why?",
            header: null,
            options: [],
            multiSelect: false,
          },
        ],
        answers: [
          {
            questionId: "q1",
            question: "Where?",
            values: ["Here"],
            notes: null,
          },
          {
            questionId: "q2",
            question: "Why?",
            values: [],
            notes: null,
          },
        ],
      },
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("answered_questions");
    if (timeline[0]?.kind !== "answered_questions") {
      throw new Error("Expected answered questions item");
    }
    expect(timeline[0].summary).toBe("Answered 1/2 questions");
  });

  it("suppresses Claude RequestUserInput tools once the interview segment exists", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "RequestUserInput", {
        questions: [{ question: "Where?", options: [] }],
      }),
      {
        ...interviewSegment("tool-1:interview"),
        toolName: "RequestUserInput",
      },
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("answered_questions");
  });

  it("suppresses A2A request_user_input tools even when the interview block id does not match", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("raw-question-tool", "request_user_input", {
        questions: [{ question: "Where?", options: [] }],
      }),
      {
        ...interviewSegment("request_user_input:generated"),
        toolName: "request_user_input",
      },
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("answered_questions");
  });

  it("suppresses orphan A2A request_user_input tools when a separate completed interview exists", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("orphan-question-tool", "request_user_input", {
        questions: [{ question: "Which environment?", options: [] }],
      }),
      {
        ...interviewSegment("request_user_input:separate"),
        toolName: "request_user_input",
        questions: [
          {
            questionId: "q1",
            question: "Continue?",
            header: null,
            options: [],
            multiSelect: false,
          },
        ],
        answers: [
          {
            questionId: "q1",
            question: "Continue?",
            values: ["Yes"],
            notes: null,
          },
        ],
      },
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("answered_questions");
    if (timeline[0]?.kind !== "answered_questions") {
      throw new Error("Expected answered questions item");
    }
    expect(timeline[0].summary).toBe("Answered 1 question");
  });

  it("does not suppress unmatched question tools", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "question", {
        questions: [{ question: "Where?", options: [] }],
      }),
    ]);

    expect(timeline[0]?.kind).toBe("activity_group");
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    expect(timeline[0].group.summary).toBe("Used 1 tool");
  });

  it("summarizes known operational buckets with Codex-like verbs", () => {
    expect(
      activityGroupSummary([
        toolSegment("tool-1", "glob", { pattern: "src/**/*.ts" }),
        toolSegment("tool-2", "read_file", { path: "/repo/a.ts" }),
        toolSegment("tool-3", "grep", { query: "Activity" }),
        toolSegment("tool-4", "edit_file", { path: "/repo/a.ts" }),
        commandSegment("command-1", "bun test", false),
      ]),
    ).toBe(
      "Explored 1 file, read 1 file, searched 1 place, edited 1 file, ran 1 command",
    );
  });

  it("groups web_fetch alongside web_search in the search bucket", () => {
    expect(
      activityGroupSummary([
        toolSegment("tool-1", "web_search", { query: "traycer" }),
        toolSegment("tool-2", "web_fetch", { url: "https://example.com" }),
      ]),
    ).toBe("Searched 2 places");
  });

  it("deduplicates repeated edits to the same file in the summary", () => {
    expect(
      activityGroupSummary([
        toolSegment("tool-1", "edit_file", { path: "/repo/a.ts" }),
        toolSegment("tool-2", "edit_file", { path: "/repo/a.ts" }),
        fileChangeSegment("file-1", "/repo/a.ts", false),
        toolSegment("tool-3", "edit_file", { path: "/repo/b.ts" }),
      ]),
    ).toBe("Edited 2 files");
  });

  it("dedupes edits keyed by Claude's snake_case file_path field", () => {
    // Claude's Edit/Write tools emit `file_path` (not `path`); the extractor
    // must read it so two edits + the correlated file_change collapse to one
    // file instead of counting as distinct entries keyed by tool id.
    expect(
      activityGroupSummary([
        toolSegment("tool-1", "edit_file", { file_path: "/repo/a.ts" }),
        toolSegment("tool-2", "edit_file", { file_path: "/repo/a.ts" }),
        fileChangeSegment("file-1", "/repo/a.ts", false),
      ]),
    ).toBe("Edited 1 file");
  });

  it("falls through a non-string path to file_path when deduping edits", () => {
    // A defined-but-non-string `path` must not block the fallthrough to a valid
    // `file_path` (the old `??`-before-coerce bug fell back to the tool id).
    expect(
      activityGroupSummary([
        toolSegment("tool-1", "edit_file", {
          path: 0,
          file_path: "/repo/a.ts",
        }),
        toolSegment("tool-2", "edit_file", {
          path: 0,
          file_path: "/repo/a.ts",
        }),
      ]),
    ).toBe("Edited 1 file");
  });

  it("keeps activity summaries subagent-aware for nested callers", () => {
    expect(activityGroupSummary([subagentSegment("subagent-1", false)])).toBe(
      "Spawned 1 subagent",
    );
  });

  it("builds concise latest-operation labels from segment details", () => {
    expect(
      latestActivityLabel(
        toolSegment("tool-1", "read_file", { path: "/repo/src/app.ts" }),
      ),
    ).toBe("Read /repo/src/app.ts");
    expect(latestActivityLabel(commandSegment("command-1", "pwd", true))).toBe(
      "Ran pwd",
    );
  });
});

function buildCompleteTimeline(
  segments: ReadonlyArray<MessageSegment>,
): ReadonlyArray<ChatActivityTimelineItem> {
  return buildChatActivityTimeline(segments, {
    turnState: "complete",
    promotedToolBlockIds: EMPTY_PROMOTED_TOOL_BLOCK_IDS,
  });
}

function buildCompleteTimelineWithPromoted(
  segments: ReadonlyArray<MessageSegment>,
  promotedToolBlockIds: ReadonlySet<string>,
): ReadonlyArray<ChatActivityTimelineItem> {
  return buildChatActivityTimeline(segments, {
    turnState: "complete",
    promotedToolBlockIds,
  });
}

function buildActiveTimeline(
  segments: ReadonlyArray<MessageSegment>,
): ReadonlyArray<ChatActivityTimelineItem> {
  return buildChatActivityTimeline(segments, {
    turnState: "active",
    promotedToolBlockIds: EMPTY_PROMOTED_TOOL_BLOCK_IDS,
  });
}

function textSegment(id: string, markdown: string): MessageSegment {
  return { id, kind: "text", markdown, isStreaming: false };
}

function toolSegment(
  id: string,
  toolName: string,
  input: unknown,
): Extract<MessageSegment, { kind: "tool" }> {
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

function a2aToolSegment(
  id: string,
  toolName: string,
  send: AgentMessageSend,
): Extract<MessageSegment, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    toolName,
    ...toolInputFields(toolName, {
      toAgentId: send.receiverAgentId,
      message: send.message,
      responseId: send.responseId,
      expectReply: send.expectReply,
    }),
    error: null,
    agentMessageSend: send,
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

function commandSegment(
  id: string,
  command: string,
  isStreaming: boolean,
): Extract<MessageSegment, { kind: "command" }> {
  return {
    id,
    kind: "command",
    command,
    cwd: null,
    exitCode: isStreaming ? null : 0,
    isStreaming,
    endState: null,
    progress: null,
    startedAt: 0,
    parentId: null,
  };
}

function fileChangeSegment(
  id: string,
  filePath: string,
  isStreaming: boolean,
): Extract<MessageSegment, { kind: "file_change" }> {
  return {
    id,
    kind: "file_change",
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    additions: 1,
    deletions: 1,
    sourceBlockIds: [id],
    reason: "snapshot",
    isStreaming,
    endState: null,
    parentId: null,
  };
}

function subagentSegment(
  id: string,
  isStreaming: boolean,
): Extract<MessageSegment, { kind: "subagent" }> {
  return {
    id,
    kind: "subagent",
    name: "reviewer",
    agentType: null,
    task: "Review the implementation",
    progressUpdates: ["Scanning files"],
    result: isStreaming ? null : "Found the issue.",
    isStreaming,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    children: [],
  };
}

function reasoningSegment(id: string, isStreaming: boolean): MessageSegment {
  return {
    id,
    kind: "reasoning",
    markdown: "Thinking",
    isStreaming,
    durationMs: null,
  };
}

function todoSegment(id: string): MessageSegment {
  return {
    id,
    kind: "todo",
    items: [
      {
        id: "todo-item-1",
        status: "pending",
        text: "Check",
        priority: null,
        activeForm: null,
      },
    ],
  };
}

function interviewSegment(
  id: string,
): Extract<MessageSegment, { kind: "interview" }> {
  return {
    id,
    kind: "interview",
    status: "completed",
    toolName: "question",
    title: "Question",
    description: null,
    questions: [
      {
        questionId: null,
        question: "Where?",
        header: null,
        options: [],
        multiSelect: false,
      },
    ],
    answers: [
      {
        questionId: null,
        question: "Where?",
        values: ["Here"],
        notes: null,
      },
    ],
    error: null,
  };
}
