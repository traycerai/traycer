import { describe, expect, it } from "vitest";
import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import type { ChatActivityTimelineItem } from "@/components/chat/chat-activity-groups";
import type { MessageSegment } from "@/stores/composer/chat-store";
import type {
  ImageGenerationResult,
  ToolCallArtifactStamp,
} from "@traycer/protocol/persistence/epic/content-blocks";

type ToolMessageSegment = Extract<MessageSegment, { kind: "tool" }>;

const NO_PROMOTED_TOOL_BLOCKS: ReadonlySet<string> = new Set();

const ARTIFACT_STAMP: ToolCallArtifactStamp = {
  artifactId: "art-1",
  title: "Report",
  manifest: { files: {}, capturedAt: 0 },
  originChatId: "chat-1",
};

const IMAGE: ImageGenerationResult = {
  attachmentHash: "hash-1",
  mediaType: "image/png",
  byteLength: 256,
  width: null,
  height: null,
  alt: "plot",
  revisedPrompt: null,
  filePath: null,
};

function toolSegment(id: string, toolName: string): ToolMessageSegment {
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
    agentMessageDelivery: null,
    botSendReceipt: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    imageResults: [],
    artifact: null,
    mcpApp: null,
    startedAt: 0,
    durationMs: null,
    parentId: null,
  };
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

function standsAlone(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
  id: string,
): boolean {
  return timeline.some(
    (item) => item.kind === "segment" && item.segment.id === id,
  );
}

describe("generic tool image results in the activity timeline", () => {
  it("promotes a tool that gains imageResults at completion, and keeps it grouped without them", () => {
    const withoutImages = build([
      toolSegment("read", "read_file"),
      toolSegment("eval", "eval"),
    ]);
    expect(withoutImages).toHaveLength(1);
    expect(withoutImages[0]?.kind).toBe("activity_group");
    expect(standsAlone(withoutImages, "eval")).toBe(false);

    const withImages = build([
      toolSegment("read", "read_file"),
      { ...toolSegment("eval", "eval"), imageResults: [IMAGE] },
      toolSegment("grep", "grep"),
    ]);
    expect(withImages.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    expect(standsAlone(withImages, "eval")).toBe(true);
    expect(standsAlone(withImages, "read")).toBe(false);
  });

  it("keeps specialized branches standalone when they also carry images", () => {
    const artifact = {
      ...toolSegment("artifact", "traycer_render_inline"),
      artifact: ARTIFACT_STAMP,
      imageResults: [IMAGE],
    };
    const a2a = {
      ...toolSegment("a2a", "traycer_a2a/traycer_send_message"),
      agentMessageSend: {
        receiverAgentId: "agent-1",
        message: "hi",
        responseId: "response-1",
        expectReply: false,
      },
      imageResults: [IMAGE],
    };
    const managed = {
      ...toolSegment("shell", "mcp__traycer_a2a__traycer_run_shell"),
      managedCommand: {
        event: "started" as const,
        commandId: "cmd-1",
        description: "watcher",
        monitoring: false,
        cwd: null,
      },
      imageResults: [IMAGE],
    };

    const timeline = build([
      toolSegment("read", "read_file"),
      artifact,
      a2a,
      managed,
    ]);

    expect(standsAlone(timeline, "artifact")).toBe(true);
    expect(standsAlone(timeline, "a2a")).toBe(true);
    expect(standsAlone(timeline, "shell")).toBe(true);
    expect(standsAlone(timeline, "read")).toBe(false);
  });

  it("keeps image_generation promoted with and without results", () => {
    const timeline = build([
      toolSegment("read", "read_file"),
      toolSegment("gen-empty", "image_generation"),
      { ...toolSegment("gen-done", "image_generation"), imageResults: [IMAGE] },
    ]);

    expect(standsAlone(timeline, "gen-empty")).toBe(true);
    expect(standsAlone(timeline, "gen-done")).toBe(true);
  });
});
