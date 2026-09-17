import { describe, expect, it } from "vitest";
import {
  buildChatActivityTimeline,
  type ActivityGroupModel,
  type ChatActivityTimelineItem,
} from "@/components/chat/chat-activity-groups";
import type { MessageSegment } from "@/stores/composer/chat-store";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";

const EMPTY_PROMOTED_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

function erroredBrowserToolSegment(
  id: string,
  error: string,
): Extract<MessageSegment, { kind: "tool" }> {
  const input = { title: "Inspect checkout", code: "await page.snapshot()" };
  return {
    id,
    kind: "tool",
    toolName: "traycer-browser/repl",
    inputSummary: deriveToolInputSummary("traycer-browser/repl", input),
    inputDetail: deriveToolInputDetail("traycer-browser/repl", input),
    taskTodoItems: null,
    error,
    agentMessageSend: null,
    managedCommand: null,
    agentMessageReceipt: null,
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

function soleGroup(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
): ActivityGroupModel {
  if (timeline.length !== 1 || timeline[0]?.kind !== "activity_group") {
    throw new Error(
      `Expected exactly one activity group, got ${JSON.stringify(
        timeline.map((item) => item.kind),
      )}`,
    );
  }
  return timeline[0].group;
}

// Regression: an ordinary (non-backgrounded) browser REPL call that fails
// stays folded into the surrounding activity group like any other tool
// error - it must not flip into a standalone card just because it errored.
// `shouldPromoteToolSegment` is deliberately not keyed on error state; this
// guards that invariant now that failed browser calls carry richer error text.
describe("chat activity grouping - failed browser call", () => {
  it("keeps a failed ordinary browser REPL call inside the activity group", () => {
    const timeline = buildChatActivityTimeline(
      [
        erroredBrowserToolSegment(
          "browser-1",
          "Error: page.click: Timeout 30000ms exceeded",
        ),
      ],
      {
        turnState: "complete",
        promotedToolBlockIds: EMPTY_PROMOTED_TOOL_BLOCK_IDS,
      },
    );

    const group = soleGroup(timeline);
    expect(group.segments).toHaveLength(1);
    expect(group.segments[0]?.id).toBe("browser-1");
  });
});
