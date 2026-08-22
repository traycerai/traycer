import { describe, expect, it } from "vitest";
import { nestChildRuntimeEvent } from "../subagent-nesting";
import { accumulateEvent } from "../agent-runtime-accumulator";
import {
  steerSubmittedEventSchema,
  toolCallCompletedEventSchema,
  toolCallErroredEventSchema,
} from "../agent-runtime";
import type { RuntimeEvent } from "../agent-runtime";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";

type SubAgentBlock = Extract<ContentBlock, { type: "subagent" }>;

const PARENT = "sa-1";
// Deliberately differs from every event timestamp so the progress-line stamp
// is observably the caller's, not the event's.
const NOW = 999;

// A root row holding the owning sub-agent card and one of its in-flight tool
// calls - the state a leaked child lifecycle event would corrupt.
function openRowWithStreamingChild(): ContentBlock[] {
  let blocks: ContentBlock[] = [];
  blocks = accumulateEvent(blocks, {
    type: "subagent.started",
    blockId: PARENT,
    timestamp: 1,
    name: "explorer",
    task: "investigate",
  });
  blocks = accumulateEvent(blocks, {
    type: "tool_call.started",
    blockId: "sa-tool",
    parentBlockId: PARENT,
    timestamp: 2,
    toolName: "read_file",
    input: { path: "src/a.ts" },
    agentMessageSend: null,
  });
  return blocks;
}

function applyAll(
  blocks: ContentBlock[],
  events: ReadonlyArray<RuntimeEvent>,
): ContentBlock[] {
  return events.reduce((acc, event) => accumulateEvent(acc, event), blocks);
}

function expectSubAgentBlock(block: ContentBlock | undefined): SubAgentBlock {
  if (block?.type !== "subagent") {
    throw new Error("Expected a subagent block");
  }
  return block;
}

describe("nestChildRuntimeEvent", () => {
  describe("suppresses child lifecycle events", () => {
    it("drops a child turn.stopped so it cannot finalize the owning root row", () => {
      const turnStopped: RuntimeEvent = {
        type: "turn.stopped",
        blockId: "child-turn-1",
        timestamp: 10,
        turnId: "child-turn-1",
        reason: "user_stop",
      };
      expect(nestChildRuntimeEvent(turnStopped, PARENT, NOW)).toEqual([]);

      const blocks = openRowWithStreamingChild();
      // The damage a leak would do (pinned in detail by the accumulator's
      // own turn.stopped tests): the root row's in-flight work is cut off.
      expect(accumulateEvent(blocks, turnStopped)[0]?.status).toBe(
        "interrupted",
      );
    });

    it("drops a child turn.interrupted (including a STEER_RESTART) so it cannot supersede root work", () => {
      const steerRestart: RuntimeEvent = {
        type: "turn.interrupted",
        blockId: "child-turn-1",
        timestamp: 10,
        turnId: "child-turn-1",
        reason: "Turn interrupted to run a queued steering request.",
        code: "STEER_RESTART",
        recoverable: true,
      };
      const plainInterrupt: RuntimeEvent = {
        type: "turn.interrupted",
        blockId: "child-turn-1",
        timestamp: 10,
        turnId: "child-turn-1",
        reason: "provider disconnected",
      };
      expect(nestChildRuntimeEvent(steerRestart, PARENT, NOW)).toEqual([]);
      expect(nestChildRuntimeEvent(plainInterrupt, PARENT, NOW)).toEqual([]);

      const blocks = openRowWithStreamingChild();
      expect(accumulateEvent(blocks, steerRestart)[0]?.status).toBe(
        "superseded",
      );
    });

    it("drops a child steer.submitted instead of injecting a root-level steer boundary", () => {
      const steer = steerSubmittedEventSchema.parse({
        type: "steer.submitted",
        blockId: "steer:q1",
        timestamp: 10,
        queueItemId: "q1",
        messageId: "m-child",
        content: { type: "doc", content: [] },
      });
      expect(nestChildRuntimeEvent(steer, PARENT, NOW)).toEqual([]);

      const blocks = openRowWithStreamingChild();
      // The accumulator never threads a parent onto the steer block, so a
      // leaked child steer would read as a top-level boundary.
      const raw = accumulateEvent(blocks, steer);
      expect(raw).toHaveLength(3);
      expect(raw[2]?.type).toBe("steer");
      expect("parentBlockId" in (raw[2] ?? {})).toBe(false);
    });

    it("drops a child compaction.errored instead of minting a root-level errored compaction card", () => {
      const compactionErrored: RuntimeEvent = {
        type: "compaction.errored",
        blockId: "compaction:child",
        timestamp: 10,
        trigger: "auto",
        error: "context overflow",
      };
      expect(nestChildRuntimeEvent(compactionErrored, PARENT, NOW)).toEqual([]);

      const blocks = openRowWithStreamingChild();
      const raw = accumulateEvent(blocks, compactionErrored);
      expect(raw).toHaveLength(3);
      expect(raw[2]).toMatchObject({ type: "compaction", status: "errored" });
      expect("parentBlockId" in (raw[2] ?? {})).toBe(false);
    });

    it.each<RuntimeEvent>([
      { type: "text.delta", blockId: "t", timestamp: 10, delta: "hi" },
      { type: "text.completed", blockId: "t", timestamp: 10 },
      { type: "reasoning.delta", blockId: "r", timestamp: 10, delta: "hm" },
      { type: "reasoning.completed", blockId: "r", timestamp: 10 },
      {
        type: "turn.started",
        blockId: "child-turn-1",
        timestamp: 10,
        turnId: "child-turn-1",
      },
      {
        type: "turn.completed",
        blockId: "child-turn-1",
        timestamp: 10,
        turnId: "child-turn-1",
      },
      {
        type: "usage.updated",
        blockId: "child-turn-1",
        timestamp: 10,
        turnId: "child-turn-1",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      {
        type: "error",
        blockId: "err",
        timestamp: 10,
        message: "boom",
        recoverable: false,
      },
      { type: "todo.updated", blockId: "todo", timestamp: 10, items: [] },
      { type: "compaction.started", blockId: "c", timestamp: 10 },
      { type: "compaction.completed", blockId: "c", timestamp: 10 },
    ])(
      "keeps the pre-existing suppressed narration/lifecycle set intact ($type)",
      (event) => {
        expect(nestChildRuntimeEvent(event, PARENT, NOW)).toEqual([]);
      },
    );
  });

  describe("nests ordinary child activity", () => {
    it("nests a child command.started under the card and streams a normalized progress line stamped with the caller's timestamp", () => {
      const event: RuntimeEvent = {
        type: "command.started",
        blockId: "cmd-1",
        timestamp: 10,
        command: "  bun   test\n  --watch  ",
        cwd: "/repo",
      };
      const out = nestChildRuntimeEvent(event, PARENT, NOW);
      expect(out).toEqual([
        { ...event, parentBlockId: PARENT },
        {
          type: "subagent.progress",
          blockId: PARENT,
          timestamp: NOW,
          update: "bun test --watch",
        },
      ]);

      const blocks = applyAll(openRowWithStreamingChild(), out);
      const card = expectSubAgentBlock(blocks[0]);
      expect(card.progressUpdates).toEqual(["bun test --watch"]);
      expect(blocks[2]).toMatchObject({
        type: "command",
        blockId: "cmd-1",
        parentBlockId: PARENT,
      });
    });

    it("nests a child tool_call.started and streams 'tool · summary' using the shared tool-input summary", () => {
      const event: RuntimeEvent = {
        type: "tool_call.started",
        blockId: "tc-1",
        timestamp: 10,
        toolName: "read_file",
        input: { path: "src/a.ts", startLine: 3, endLine: 9 },
        agentMessageSend: null,
      };
      expect(nestChildRuntimeEvent(event, PARENT, NOW)).toEqual([
        { ...event, parentBlockId: PARENT },
        {
          type: "subagent.progress",
          blockId: PARENT,
          timestamp: NOW,
          update: "read_file · src/a.ts:3-9",
        },
      ]);
    });

    it("falls back to the bare tool name when the input yields no summary", () => {
      const withEmptyInput: RuntimeEvent = {
        type: "tool_call.started",
        blockId: "tc-1",
        timestamp: 10,
        toolName: "custom_tool",
        input: {},
        agentMessageSend: null,
      };
      const withoutInput: RuntimeEvent = {
        type: "tool_call.started",
        blockId: "tc-2",
        timestamp: 10,
        toolName: "custom_tool",
        agentMessageSend: null,
      };
      for (const event of [withEmptyInput, withoutInput]) {
        expect(nestChildRuntimeEvent(event, PARENT, NOW)[1]).toMatchObject({
          type: "subagent.progress",
          blockId: PARENT,
          update: "custom_tool",
        });
      }
    });

    it("nests tool_call.progress without echoing it as a subagent.progress line", () => {
      const event: RuntimeEvent = {
        type: "tool_call.progress",
        blockId: "tc-1",
        timestamp: 10,
        update: "Fetched 37/200",
      };
      expect(nestChildRuntimeEvent(event, PARENT, NOW)).toEqual([
        { ...event, parentBlockId: PARENT },
      ]);
    });

    it.each<RuntimeEvent>([
      toolCallCompletedEventSchema.parse({
        type: "tool_call.completed",
        blockId: "tc-1",
        timestamp: 10,
        toolName: "read_file",
      }),
      toolCallErroredEventSchema.parse({
        type: "tool_call.errored",
        blockId: "tc-1",
        timestamp: 10,
        toolName: "read_file",
        error: "boom",
      }),
      {
        type: "command.completed",
        blockId: "cmd-1",
        timestamp: 10,
        command: "bun test",
        exitCode: 0,
      },
      {
        type: "file_change.started",
        blockId: "fc-1",
        timestamp: 10,
        filePath: "/repo/a.ts",
        operation: "modify",
      },
      {
        type: "file_change.completed",
        blockId: "fc-1",
        timestamp: 10,
        filePath: "/repo/a.ts",
        operation: "modify",
        diffSource: "snapshot",
        beforeHash: null,
        afterHash: null,
        additions: 1,
        deletions: 0,
        reason: "snapshot",
      },
      {
        type: "artifact_operation",
        blockId: "art-1",
        timestamp: 10,
        operation: "create",
        kind: "review",
        artifactId: "review-1",
      },
    ])(
      "nests non-start activity as a single tagged event with no progress line ($type)",
      (event) => {
        expect(nestChildRuntimeEvent(event, PARENT, NOW)).toEqual([
          { ...event, parentBlockId: PARENT },
        ]);
      },
    );

    it("tags a nested sub-agent's own card and a child interview prompt with the owning card (placement is the renderer's call)", () => {
      const nestedStart: RuntimeEvent = {
        type: "subagent.started",
        blockId: "sa-2",
        timestamp: 10,
        name: "reviewer",
        task: "review",
      };
      const nestedDone: RuntimeEvent = {
        type: "subagent.completed",
        blockId: "sa-2",
        timestamp: 11,
        outcome: "completed",
        result: "ok",
      };
      const interview: RuntimeEvent = {
        type: "interview.requested",
        blockId: "iv-1",
        timestamp: 12,
        toolName: "AskUserQuestion",
        questions: [],
      };
      for (const event of [nestedStart, nestedDone, interview]) {
        expect(nestChildRuntimeEvent(event, PARENT, NOW)).toEqual([
          { ...event, parentBlockId: PARENT },
        ]);
      }
    });

    it("re-homes an already-tagged child event under the card it is passed (owner wins)", () => {
      const event: RuntimeEvent = {
        type: "tool_call.started",
        blockId: "tc-1",
        parentBlockId: "some-other-card",
        timestamp: 10,
        toolName: "read_file",
        agentMessageSend: null,
      };
      expect(nestChildRuntimeEvent(event, PARENT, NOW)[0]?.parentBlockId).toBe(
        PARENT,
      );
    });

    it("omits the progress line for a whitespace-only command and caps an over-long one", () => {
      const blank: RuntimeEvent = {
        type: "command.started",
        blockId: "cmd-1",
        timestamp: 10,
        command: "   \n  ",
      };
      expect(nestChildRuntimeEvent(blank, PARENT, NOW)).toHaveLength(1);

      const long: RuntimeEvent = {
        type: "command.started",
        blockId: "cmd-2",
        timestamp: 10,
        command: "x".repeat(120),
      };
      const progress = nestChildRuntimeEvent(long, PARENT, NOW)[1];
      if (progress?.type !== "subagent.progress") {
        throw new Error("Expected a subagent.progress line");
      }
      expect(progress.update).toHaveLength(80);
      expect(progress.update.endsWith("…")).toBe(true);
    });
  });
});
