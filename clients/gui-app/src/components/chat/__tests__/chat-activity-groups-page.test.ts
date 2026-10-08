import { describe, expect, it } from "vitest";
import {
  buildChatActivityTimeline,
  isShowPageToolName,
} from "@/components/chat/chat-activity-groups";
import type { ChatActivityTimelineItem } from "@/components/chat/chat-activity-groups";
import type { MessageSegment } from "@/stores/composer/chat-store";
import type { ToolCallPageStamp } from "@traycer/protocol/persistence/epic/content-blocks";

type ToolMessageSegment = Extract<MessageSegment, { kind: "tool" }>;

const NO_PROMOTED_TOOL_BLOCKS: ReadonlySet<string> = new Set();

const PAGE_STAMP: ToolCallPageStamp = {
  path: "files/pages/report-1.html",
  sha256: "a".repeat(64),
  title: "Report",
  height: 400,
  heights: [],
  derivedFrom: null,
  originChatId: "chat-1",
};

function toolSegment(
  id: string,
  toolName: string,
  page: ToolCallPageStamp | null,
  isStreaming: boolean,
): ToolMessageSegment {
  return {
    id,
    kind: "tool",
    toolName,
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
    isStreaming,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    imageResults: [],
    page,
    startedAt: 0,
    durationMs: null,
    parentId: null,
  };
}

function textSegment(id: string): MessageSegment {
  return { id, kind: "text", markdown: id, isStreaming: false };
}

function build(
  segments: ReadonlyArray<MessageSegment>,
): ReadonlyArray<ChatActivityTimelineItem> {
  return buildChatActivityTimeline(segments, {
    turnState: "complete",
    promotedToolBlockIds: NO_PROMOTED_TOOL_BLOCKS,
    hideReasoning: false,
  });
}

/** The timeline item for `id`, whether it stands alone or sits in a group. */
function standsAlone(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
  id: string,
): boolean {
  return timeline.some(
    (item) => item.kind === "segment" && item.segment.id === id,
  );
}

describe("show-page calls in the activity timeline", () => {
  it("promotes a stamped page out of the group, between the tools around it", () => {
    const timeline = build([
      textSegment("intro"),
      toolSegment("read", "read_file", null, false),
      toolSegment("page", "traycer_show_page", PAGE_STAMP, false),
      toolSegment("grep", "grep", null, false),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "segment",
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(standsAlone(timeline, "page")).toBe(true);
  });

  it("promotes a stamped page whatever its tool name is spelled", () => {
    const timeline = build([
      toolSegment("read", "read_file", null, false),
      toolSegment("page", "some_other_name", PAGE_STAMP, false),
    ]);

    expect(standsAlone(timeline, "page")).toBe(true);
  });

  it("promotes a still-streaming show-page call by name, before it has a stamp", () => {
    const timeline = build([
      toolSegment("read", "read_file", null, false),
      toolSegment("page", "mcp__traycer_a2a__traycer_show_page", null, true),
    ]);

    expect(standsAlone(timeline, "page")).toBe(true);
  });

  it("folds a preview call into the group, since it is the agent checking its work", () => {
    const timeline = build([
      toolSegment("read", "read_file", null, false),
      toolSegment("preview", "traycer_preview_page", null, false),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("activity_group");
    expect(standsAlone(timeline, "preview")).toBe(false);
  });

  it.each(["not_traycer_show_page", "other_server/traycer_show_page"])(
    "folds an unstamped %s into the group, since only our spellings are pages",
    (toolName) => {
      const timeline = build([
        toolSegment("read", "read_file", null, false),
        toolSegment("impostor", toolName, null, true),
      ]);

      expect(timeline).toHaveLength(1);
      expect(standsAlone(timeline, "impostor")).toBe(false);
    },
  );
});

describe("isShowPageToolName", () => {
  it.each([
    "traycer_show_page",
    "traycer_a2a/traycer_show_page",
    "mcp__traycer_a2a__traycer_show_page",
    "MCP__Traycer-A2A__Traycer-Show-Page",
  ])("matches %s", (name) => {
    expect(isShowPageToolName(name)).toBe(true);
  });

  it.each([
    "traycer_preview_page",
    "mcp__traycer_a2a__traycer_preview_page",
    "show_page",
    "traycer_show_page_now",
    "not_traycer_show_page",
    "mcp__other__traycer_show_page",
  ])("does not match %s", (name) => {
    expect(isShowPageToolName(name)).toBe(false);
  });
});
