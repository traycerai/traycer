import { describe, expect, it } from "vitest";
import {
  activityGroupSummary,
  buildChatActivityTimeline,
  hidesSoleReasoningHeader,
  latestActivityLabel,
  reasoningSummaryLabel,
} from "@/components/chat/chat-activity-groups";
import type {
  ActivityGroupModel,
  ChatActivityTimelineItem,
} from "@/components/chat/chat-activity-groups";
import { deriveActivityGroupRenderId } from "@/components/chat/chat-collapsible-key";
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
      commandSegment("command-1", "bun test", false, null),
      textSegment("text-2", "Second"),
      commandSegment("command-2", "git status", false, null),
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
      commandSegment("command-1", "pwd", false, null),
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
      commandSegment("command-1", "pwd", false, null),
      todoSegment("todo-1"),
      commandSegment("command-2", "ls", false, null),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
  });

  it("keeps provider notices out of activity groups", () => {
    const timeline = buildCompleteTimeline([
      commandSegment("command-1", "pwd", false, null),
      providerNoticeSegment("notice-1"),
      commandSegment("command-2", "ls", false, null),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
  });

  it("folds a completed reasoning block into the following activity group", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false, 2000),
      commandSegment("command-1", "bun test", false, null),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual(["activity_group"]);
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected a single merged activity group");
    }
    expect(timeline[0].group.summary).toBe("Thought for 2s, ran 1 command");
    expect(timeline[0].group.segments.map((segment) => segment.kind)).toEqual([
      "reasoning",
      "command",
    ]);
  });

  it("accumulates duration across every reasoning block in the run", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false, 2000),
      commandSegment("command-1", "pwd", false, null),
      reasoningSegment("reasoning-2", false, 4000),
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual(["activity_group"]);
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected a single merged activity group");
    }
    expect(timeline[0].group.summary).toBe(
      "Thought for 6s, read 1 file, ran 1 command",
    );
    expect(timeline[0].group.segments.map((segment) => segment.kind)).toEqual([
      "reasoning",
      "command",
      "reasoning",
      "tool",
    ]);
  });

  it("merges consecutive completed reasoning blocks and still breaks on text", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false, 1000),
      reasoningSegment("reasoning-2", false, 1000),
      textSegment("text-1", "Done"),
    ]);

    expect(timeline.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
    ]);
    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected a single merged activity group");
    }
    expect(timeline[0].group.summary).toBe("Thought for 2s");
    expect(timeline[0].group.segments.map((segment) => segment.kind)).toEqual([
      "reasoning",
      "reasoning",
    ]);
    if (timeline[1]?.kind !== "segment") {
      throw new Error("Expected the trailing text segment");
    }
    expect(timeline[1].segment.kind).toBe("text");
  });

  // The invariant the whole design rests on: a reasoning block occupies the
  // SAME container before and after it stops streaming. #597 shipped the
  // opposite (standalone while streaming, folded once complete) and had to be
  // reverted, because the fold happened into a COLLAPSED group - so a block
  // that had grown for seconds vanished whole in one frame and snapped the run
  // indicator up behind it.
  it("keeps a streaming reasoning block in the group it will still be in once complete", () => {
    const streamingTimeline = buildCompleteTimeline([
      commandSegment("command-1", "pwd", false, null),
      reasoningSegment("reasoning-1", true, null),
    ]);

    expect(streamingTimeline.map((item) => item.kind)).toEqual([
      "activity_group",
    ]);
    if (streamingTimeline[0]?.kind !== "activity_group") {
      throw new Error("Expected the streaming reasoning block to be grouped");
    }
    expect(
      streamingTimeline[0].group.segments.map((segment) => segment.kind),
    ).toEqual(["command", "reasoning"]);
    // No duration yet, so the summary leads with the live clause instead of
    // falling through to a duration that does not exist.
    expect(streamingTimeline[0].group.summary).toBe("Thinking, ran 1 command");

    const completedTimeline = buildCompleteTimeline([
      commandSegment("command-1", "pwd", false, null),
      reasoningSegment("reasoning-1", false, 3000),
    ]);

    expect(completedTimeline.map((item) => item.kind)).toEqual([
      "activity_group",
    ]);
    if (completedTimeline[0]?.kind !== "activity_group") {
      throw new Error("Expected the completed reasoning to stay grouped");
    }
    // Same container, same children - only the summary's leading clause moved
    // from "Thinking" to a settled duration.
    expect(
      completedTimeline[0].group.segments.map((segment) => segment.kind),
    ).toEqual(["command", "reasoning"]);
    expect(completedTimeline[0].group.summary).toBe(
      "Thought for 3s, ran 1 command",
    );
  });

  // A lone reasoning block is the commonest shape there is (think, then
  // answer). #597 special-cased it to a standalone segment to avoid a duplicate
  // "Thought for Xs" header, but that decision flips the instant a tool call
  // joins it - another mid-turn container change. It is a group from the first
  // token; the duplicate header is suppressed at render time instead.
  it("groups a lone reasoning block, streaming and completed alike", () => {
    const streaming = buildCompleteTimeline([
      reasoningSegment("reasoning-1", true, null),
    ]);
    expect(streaming.map((item) => item.kind)).toEqual(["activity_group"]);
    if (streaming[0]?.kind !== "activity_group") {
      throw new Error("Expected a group around the streaming lone block");
    }
    expect(streaming[0].group.summary).toBe("Thinking");

    const completed = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false, 3000),
    ]);
    expect(completed.map((item) => item.kind)).toEqual(["activity_group"]);
    if (completed[0]?.kind !== "activity_group") {
      throw new Error("Expected a group around the completed lone block");
    }
    expect(completed[0].group.summary).toBe("Thought for 3s");
  });

  // `completedDurationMs` yields null for a block with no `startedAt` (any
  // persisted history predating that field) and 0 for one that began and ended
  // inside the same millisecond. Both summed to 0, and a summary built only
  // from counts then fell through to the generic "Ran activity" - so a lone
  // reasoning block advertised itself as an unspecified tool run, and the word
  // "Thought" it used to render for itself vanished from the find index too.
  //
  // The two are NOT the same label. 0 is a measurement, and the block renders
  // it as "Thought for 1s" because "Thought for 0s" describes nothing; null is
  // the absence of one. Summing collapsed the distinction, so the group said
  // "Thought" over a child saying "Thought for 1s" - and `hidesSoleReasoningHeader`
  // then deleted the child's header on the strength of the two being identical,
  // taking the only "Thought for 1s" in the transcript, and its find unit, with it.
  it.each([
    ["no duration at all", null, "Thought"],
    ["a zero duration", 0, "Thought for 1s"],
  ])(
    "labels a completed lone reasoning block with %s exactly as the block labels itself",
    (_, ms, expected) => {
      const timeline = buildCompleteTimeline([
        reasoningSegment("reasoning-1", false, ms),
      ]);

      if (timeline[0]?.kind !== "activity_group") {
        throw new Error("Expected a group around the lone block");
      }
      expect(timeline[0].group.summary).toBe(expected);
      // The equality the header-suppression rule rests on, asserted rather than
      // assumed: the group's whole label IS what the child would have rendered.
      expect(timeline[0].group.summary).toBe(reasoningSummaryLabel(ms));
      expect(hidesSoleReasoningHeader(timeline[0].group.segments)).toBe(true);
    },
  );

  // The same equality across the range, so a formatter change on either side
  // cannot quietly break the premise for some durations and not others.
  it.each([null, 0, 1, 400, 500, 1000, 2400, 2500, 61_000, 3_600_000])(
    "keeps the sole-reasoning group label identical to the block's own label (%s ms)",
    (ms) => {
      const timeline = buildCompleteTimeline([
        reasoningSegment("reasoning-1", false, ms),
      ]);
      if (timeline[0]?.kind !== "activity_group") {
        throw new Error("Expected a group around the lone block");
      }
      expect(timeline[0].group.label).toBe(reasoningSummaryLabel(ms));
    },
  );

  // The clause moves forward only. A new block starting to stream says nothing
  // about what the run has already done, and letting it lead made the header
  // shuttle - reported from the running app, fixed once for the duration case,
  // and still live here: with no `startedAt` in persisted history the total
  // stays 0, so a duration-only guard never fired and `Thought` went back to
  // `Thinking` on the next block.
  it("never returns to thinking once a block has completed, even with no durations", () => {
    const completed = reasoningSegment("reasoning-1", false, null);
    expect(soleGroupLabel(buildActiveTimeline([completed]))).toBe("Thought");

    const withNewStream = buildActiveTimeline([
      completed,
      reasoningSegment("reasoning-2", true, null),
    ]);
    expect(soleGroupLabel(withNewStream)).toBe("Thought");

    const bothDone = buildActiveTimeline([
      completed,
      reasoningSegment("reasoning-2", false, null),
    ]);
    expect(soleGroupLabel(bothDone)).toBe("Thought");
  });

  // A finished block with no duration is NOT only a history artifact: an
  // interrupted, superseded or errored block is finished and unmeasurable too
  // (`completedDurationMs` returns null because its timestamp is the turn-end),
  // so a run can mix measured and unmeasurable blocks live. The sum is then a
  // floor, and saying "Thought for 5s" claims a total nobody measured.
  it("marks a duration that is only a floor when a finished block was unmeasurable", () => {
    const timeline = buildActiveTimeline([
      reasoningSegment("reasoning-1", false, 5_000),
      reasoningSegment("reasoning-2", false, null),
    ]);

    expect(soleGroupLabel(timeline)).toBe("Thought for 5s+");
  });

  // The reason it is a "+" and not a fallback to the duration-less "Thought":
  // that fallback walks the label BACKWARDS the moment an unmeasurable block
  // joins a run that had already measured one - which is the exact shuttle
  // `thinkingCompleted` was added to stop, one field over. A floor only grows.
  it("never drops a measured duration when an unmeasurable block joins", () => {
    const measured = reasoningSegment("reasoning-1", false, 5_000);
    expect(soleGroupLabel(buildActiveTimeline([measured]))).toBe(
      "Thought for 5s",
    );

    const joined = buildActiveTimeline([
      measured,
      reasoningSegment("reasoning-2", false, null),
    ]);
    expect(soleGroupLabel(joined)).toBe("Thought for 5s+");

    const grown = buildActiveTimeline([
      measured,
      reasoningSegment("reasoning-2", false, null),
      reasoningSegment("reasoning-3", false, 6_000),
    ]);
    expect(soleGroupLabel(grown)).toBe("Thought for 11s+");
  });

  // The "+" has no analogue in `reasoningSummaryLabel`, so it would break the
  // equality `hidesSoleReasoningHeader` bets on if it could ever appear on a
  // sole block. It cannot: it needs one measured block AND one unmeasurable
  // one, and that is two segments. Asserted rather than argued.
  it.each([null, 0, 5_000])(
    "never marks a sole reasoning block as a floor (%s ms)",
    (ms) => {
      const timeline = buildCompleteTimeline([
        reasoningSegment("reasoning-1", false, ms),
      ]);
      const group = soleGroup(timeline, 0);

      expect(group.label).not.toContain("+");
      expect(group.label).toBe(reasoningSummaryLabel(ms));
      expect(hidesSoleReasoningHeader(group.segments)).toBe(true);
    },
  );

  // A block still STREAMING is not a finished-but-unmeasurable one. It carries
  // no duration either, but counting it as a floor marker would put a "+" on
  // every run that is merely still thinking.
  it("does not mark a floor for a block that is still streaming", () => {
    const timeline = buildActiveTimeline([
      reasoningSegment("reasoning-1", false, 5_000),
      reasoningSegment("reasoning-2", true, null),
    ]);

    expect(soleGroupLabel(timeline)).toBe("Thought for 5s");
  });

  // The header-suppression rule is keyed on the group's SHAPE, and the shape is
  // NOT append-only: a backgrounded command and a matched question tool both
  // leave the run they were in. The group id comes from the first segment, so
  // the list shrinks under an unchanged id on a mounted component - and a
  // shape-only rule would flip back to headerless there and unfold a completed
  // trace nobody opened.
  describe("shape removals", () => {
    // The removal itself, at the model level: same group id, one member fewer,
    // and the shape rule duly flips back to headerless. That flip is REAL and is
    // not corrected here - `ActivityGroupSegment` latches the header on its own
    // render history, because two of the three removal paths are invisible from
    // this file (`buildAssistantSegments` suppresses subagent spawn tools and
    // edit tool calls before this builder ever runs).
    it("shrinks a group in place when its command is promoted to the background", () => {
      const segments = [
        reasoningSegment("reasoning-1", false, 2000),
        commandSegment("command-1", "bun test", true, null),
      ];

      const before = soleGroup(buildCompleteTimeline(segments), 0);
      expect(before.segments).toHaveLength(2);
      expect(hidesSoleReasoningHeader(before.segments)).toBe(false);

      // The host starts tracking the exec as a background item mid-turn.
      const after = soleGroup(
        buildCompleteTimelineWithPromoted(segments, new Set(["command-1"])),
        0,
      );
      // The id is what makes this dangerous: React keeps the same component.
      expect(after.id).toBe(before.id);
      expect(after.segments).toHaveLength(1);
      expect(hidesSoleReasoningHeader(after.segments)).toBe(true);
    });

    it("shrinks a group in place when a question tool's interview arrives", () => {
      const questionTool = toolSegment("tool-1", "question", {
        questions: [{ question: "Where?", options: [] }],
      });
      const reasoning = reasoningSegment("reasoning-1", false, 2000);

      const before = soleGroup(
        buildCompleteTimeline([reasoning, questionTool]),
        0,
      );
      expect(before.segments).toHaveLength(2);

      const after = soleGroup(
        buildCompleteTimeline([
          reasoning,
          questionTool,
          interviewSegment("tool-1:interview"),
        ]),
        0,
      );
      expect(after.id).toBe(before.id);
      expect(after.segments).toHaveLength(1);
    });

    // A run that STARTS after a promoted card is a different group with a
    // different id, so it is a fresh component with no header to preserve. An
    // earlier revision marked it as a remnant anyway, which put the duplicate
    // `Thinking` header back on every message beginning with a background
    // command - reinstating the exact defect the rule exists to remove.
    it("gives the run after a promoted segment its own id", () => {
      const timeline = buildCompleteTimelineWithPromoted(
        [
          commandSegment("command-1", "bun test", true, null),
          reasoningSegment("reasoning-1", false, 2000),
        ],
        new Set(["command-1"]),
      );

      const group = soleGroup(timeline, 1);
      expect(group.id).toBe(deriveActivityGroupRenderId("reasoning-1"));
      expect(hidesSoleReasoningHeader(group.segments)).toBe(true);
    });

    it("leaves an untouched sole reasoning group headerless", () => {
      const group = soleGroup(
        buildCompleteTimeline([reasoningSegment("reasoning-1", false, 2000)]),
        0,
      );
      expect(hidesSoleReasoningHeader(group.segments)).toBe(true);
    });
  });

  it("leads with thinking only while nothing has completed yet", () => {
    const timeline = buildActiveTimeline([
      reasoningSegment("reasoning-1", true, null),
    ]);
    expect(soleGroupLabel(timeline)).toBe("Thinking");
  });

  // A streaming block contributes no duration even when it carries one:
  // `ReasoningSegment` labels a streaming block "Thinking" and ignores the
  // number, so counting it would let the group read "Thought for 3s" over a
  // child still reading "Thinking" - and the header-suppression rule would then
  // hide a header that did NOT say the same thing.
  it("ignores a streaming block's duration so the group cannot outrun the child", () => {
    const timeline = buildActiveTimeline([
      reasoningSegment("reasoning-1", true, 3000),
    ]);
    // "Thinking" is what `ReasoningSegment` renders for any streaming block,
    // whatever its duration - so this is the label equality again, for the one
    // case `reasoningSummaryLabel` is not consulted.
    expect(soleGroupLabel(timeline)).toBe("Thinking");
  });

  it("still leads with the thinking clause when a duration-less block has siblings", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false, null),
      commandSegment("command-1", "bun test", false, null),
    ]);

    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected one activity group");
    }
    expect(timeline[0].group.summary).toBe("Thought, ran 1 command");
  });

  // The accumulated duration OUTRANKS a still-streaming block, so the clause
  // only ever grows. Leading with a bare "thinking" whenever anything streamed
  // made the header shuttle - "Thought for 4s, read 1 file" -> "Thinking" ->
  // "Thought for 9s, read 1 file" - on every new block, and the middle state
  // was a run that had demonstrably read a file describing itself as nothing
  // but a thought.
  it("keeps the accumulated duration in the summary while a later block streams", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", false, 4000),
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      reasoningSegment("reasoning-2", true, null),
    ]);

    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected one activity group");
    }
    expect(timeline[0].group.summary).toBe("Thought for 4s, read 1 file");
  });

  // The one case with no duration to show: nothing has finished thinking yet.
  it("reads 'Thinking' only until the first block completes", () => {
    const timeline = buildCompleteTimeline([
      reasoningSegment("reasoning-1", true, null),
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
    ]);

    if (timeline[0]?.kind !== "activity_group") {
      throw new Error("Expected one activity group");
    }
    expect(timeline[0].group.summary).toBe("Thinking, read 1 file");
  });

  // Monotonic: every new block can only push the clause forward, never back to
  // a label the reader already saw replaced.
  it("never regresses the thinking clause as blocks accumulate", () => {
    const summaryOf = (segments: ReadonlyArray<MessageSegment>): string => {
      const timeline = buildCompleteTimeline(segments);
      if (timeline[0]?.kind !== "activity_group") {
        throw new Error("Expected one activity group");
      }
      return timeline[0].group.summary;
    };

    expect([
      summaryOf([reasoningSegment("reasoning-1", true, null)]),
      summaryOf([reasoningSegment("reasoning-1", false, 4000)]),
      summaryOf([
        reasoningSegment("reasoning-1", false, 4000),
        reasoningSegment("reasoning-2", true, null),
      ]),
      summaryOf([
        reasoningSegment("reasoning-1", false, 4000),
        reasoningSegment("reasoning-2", false, 5000),
      ]),
    ]).toEqual([
      "Thinking",
      "Thought for 4s",
      "Thought for 4s",
      "Thought for 9s",
    ]);
  });

  it("keeps streaming activity active with a stable summary label", () => {
    const timeline = buildCompleteTimeline([
      toolSegment("tool-1", "read_file", { path: "/repo/a.ts" }),
      commandSegment("command-1", "bun test", true, null),
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
      commandSegment("command-1", "bun test", true, null),
    ]);
    if (streaming[0]?.kind !== "activity_group") {
      throw new Error("Expected activity group");
    }
    // A streaming tool/command anchors the header elapsed.
    expect(streaming[0].group.activeStartedAt).not.toBeNull();

    const done = buildCompleteTimeline([
      commandSegment("command-1", "bun test", false, null),
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
      commandSegment("command-1", "bun test", false, null),
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

  it("promotes a backgrounded command block out of the activity group for its whole life", () => {
    // Codex decides at the parent turn's end that a still-running exec is
    // backgrounded and stamps the block; the marker is what keeps the card
    // standalone while it runs AND after it settles (command stdout is never
    // persisted, so there is no output fallback to fall back on).
    const running = buildCompleteTimeline([
      commandSegment("command-0", "pwd", false, null),
      commandSegment("command-1", "npm run dev", true, true),
      commandSegment("command-2", "ls", false, null),
    ]);
    expect(running.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
      "activity_group",
    ]);
    if (running[1]?.kind !== "segment") {
      throw new Error("Expected promoted background command");
    }
    expect(running[1].segment.id).toBe("command-1");

    const settled = buildCompleteTimeline([
      commandSegment("command-0", "pwd", false, null),
      commandSegment("command-1", "npm run dev", false, true),
    ]);
    expect(settled.map((item) => item.kind)).toEqual([
      "activity_group",
      "segment",
    ]);
  });

  it("keeps an unmarked command grouped, and promotes one the host still lists as running", () => {
    const grouped = buildCompleteTimeline([
      commandSegment("command-1", "bun test", true, null),
    ]);
    expect(grouped.map((item) => item.kind)).toEqual(["activity_group"]);

    // Live host truth promotes the card even before the marker reaches the
    // renderer - same fallback the background tool cards use.
    const promoted = buildCompleteTimelineWithPromoted(
      [commandSegment("command-1", "bun test", true, null)],
      new Set(["command-1"]),
    );
    expect(promoted.map((item) => item.kind)).toEqual(["segment"]);
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
      commandSegment("command-1", "bun test", false, null),
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
        commandSegment("command-1", "bun test", false, null),
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
    expect(
      latestActivityLabel(commandSegment("command-1", "pwd", true, null)),
    ).toBe("Ran pwd");
  });
});

function soleGroupLabel(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
): string {
  if (timeline[0]?.kind !== "activity_group") {
    throw new Error("Expected a group at the head of the timeline");
  }
  return timeline[0].group.label;
}

function soleGroup(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
  index: number,
): ActivityGroupModel {
  // Range-checked BEFORE the read. An out-of-range index is the likeliest way
  // a caller gets this wrong, and reading `.kind` off the undefined it returns
  // throws a TypeError that names neither the index nor the helper.
  //
  // Checked on the length rather than on `item === undefined`, which is the
  // obvious spelling: this repo does not set `noUncheckedIndexedAccess`, so the
  // element type excludes undefined and `no-unnecessary-condition` rejects a
  // comparison the type system believes can never be true. The runtime
  // disagrees with the type here, and the length is the part of that both agree
  // on.
  if (index < 0 || index >= timeline.length) {
    throw new Error(
      `Expected an activity group at index ${index}, but the timeline holds ${timeline.length}`,
    );
  }
  const item = timeline[index];
  if (item.kind !== "activity_group") {
    throw new Error(
      `Expected an activity group at index ${index}, got ${item.kind}`,
    );
  }
  return item.group;
}

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
  backgroundTask: boolean | null,
): Extract<MessageSegment, { kind: "command" }> {
  return {
    id,
    kind: "command",
    command,
    cwd: null,
    exitCode: isStreaming ? null : 0,
    isStreaming,
    endState: null,
    stopped: false,
    progress: null,
    startedAt: 0,
    backgroundTask,
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
    parentId: null,
    workflowMeta: null,
    children: [],
  };
}

function reasoningSegment(
  id: string,
  isStreaming: boolean,
  durationMs: number | null,
): MessageSegment {
  return {
    id,
    kind: "reasoning",
    markdown: "Thinking",
    isStreaming,
    durationMs,
  };
}

function providerNoticeSegment(
  id: string,
): Extract<MessageSegment, { kind: "provider_notice" }> {
  return {
    id,
    kind: "provider_notice",
    status: "completed",
    tone: "info",
    title: "Model verification active",
    message: null,
    details: [],
    parentId: null,
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
    forkedWithoutAnswer: false,
  };
}
