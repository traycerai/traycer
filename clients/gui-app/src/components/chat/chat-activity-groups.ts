import {
  isMonitorActivitySegment,
  type MonitorDeliverySegment,
} from "./chat-monitor-delivery";
import {
  isKnownInterviewDisplayToolName,
  toolUseIdFromInterviewBlockId,
} from "@traycer/protocol/host/agent/gui/interview-tools";
import { filePathFromInputDetail } from "@/lib/segment-summary";
import type {
  ApprovalSegment,
  CommandSegment,
  FileChangeSegment,
  MessageSegment,
  ReasoningSegment,
  SubagentSegment,
  ToolSegment,
} from "@/stores/composer/chat-store";
import { isBotSendToolName } from "@/lib/bots/bot-send-tool";
import {
  deriveActivityGroupRenderId,
  derivePromotedSubagentRenderId,
} from "./chat-collapsible-key";
import {
  activityLabelLine,
  activityToolKind,
  commandActivityLabel,
  normalizedToolName,
  toolCallActivityLabel,
} from "@traycer/protocol/host/agent/gui/activity-step-label";
import {
  activitySummaryOf,
  isMemoryUpdateToolCall,
  thoughtClockDuration,
  type ActivitySummaryStep,
} from "@traycer/protocol/host/agent/gui/activity-summary";
import type { ToolCallMcpAppStamp } from "@traycer/protocol/persistence/epic/content-blocks";

export type ActivitySegment =
  | ToolSegment
  | CommandSegment
  | FileChangeSegment
  | SubagentSegment
  | ApprovalSegment
  | MonitorDeliverySegment;

// Reasoning folds into the surrounding activity group for its whole life -
// streaming AND completed - and its duration accumulates into the "Thought for
// Xm Ys" summary clause. Admitting it unconditionally is the point: a block
// that changed container the instant it stopped streaming (born standalone,
// absorbed into a COLLAPSED group, so it vanished whole in one frame) is what
// made #597 jarring enough to revert. Nothing here may depend on `isStreaming`
// for placement - only for how the row renders itself.
export type ActivityGroupDetailSegment = ActivitySegment | ReasoningSegment;

export interface ActivityGroupModel {
  readonly id: string;
  readonly segments: ReadonlyArray<ActivityGroupDetailSegment>;
  readonly isActive: boolean;
  readonly isStreaming: boolean;
  readonly label: string;
  readonly summary: string;
  /**
   * Start (epoch ms) of the currently-streaming tool/command child, or null
   * when nothing nestable is in flight. Drives the elapsed heartbeat on the
   * (collapsed-by-default) active group header - the only always-visible
   * surface for a top-level tool's "still working / how long".
   */
  readonly activeStartedAt: number | null;
}

export type ChatActivityTimelineItem =
  | {
      readonly kind: "segment";
      readonly id: string;
      readonly segment: MessageSegment;
    }
  | {
      readonly kind: "activity_group";
      readonly id: string;
      readonly group: ActivityGroupModel;
    }
  | {
      readonly kind: "promoted_subagent";
      readonly id: string;
      readonly segment: SubagentSegment;
    };

const EMPTY_QUESTION_TOOL_IDS: ReadonlySet<string> = new Set();
const EMPTY_PROMOTED_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

export type ActivityTimelineTurnState = "active" | "complete";

export interface ActivityTimelineOptions {
  readonly turnState: ActivityTimelineTurnState;
  readonly promotedToolBlockIds: ReadonlySet<string>;
  /**
   * Layout > Chat > Thinking is Hidden: reasoning is left out of each run
   * once it is grouped, so a run of nothing but reasoning draws no row and a
   * mixed run's summary drops its "thought for" clause. The run keeps the id
   * its first member gave it, so toggling the setting never re-keys a group
   * and the reader's open/closed choice survives it (L-176). Every caller that must group as
   * the renderer does (Find, block reveal) passes the same answer.
   */
  readonly hideReasoning: boolean;
}

interface TimelineCacheEntry {
  readonly base: ReadonlyArray<ChatActivityTimelineItem>;
  active: ReadonlyArray<ChatActivityTimelineItem> | null;
}

// Timeline is purely a function of `segments` and whether reasoning is hidden.
// The base walk is turn-state independent - only the trailing-group "active"
// marker differs - so we cache the base once per `segments` identity, one cache
// per reasoning setting, and derive the active variant on demand. This avoids
// re-walking the same segments tree when the same identity is queried for both
// turn states across renders.
const timelineCache = new WeakMap<
  ReadonlyArray<MessageSegment>,
  TimelineCacheEntry
>();
const hiddenReasoningTimelineCache = new WeakMap<
  ReadonlyArray<MessageSegment>,
  TimelineCacheEntry
>();

export function buildChatActivityTimeline(
  segments: ReadonlyArray<MessageSegment>,
  options: ActivityTimelineOptions,
): ReadonlyArray<ChatActivityTimelineItem> {
  const { hideReasoning } = options;
  if (options.promotedToolBlockIds.size > 0) {
    const base = buildChatActivityTimelineImpl(
      segments,
      options.promotedToolBlockIds,
      hideReasoning,
    );
    return options.turnState === "complete"
      ? base
      : markTrailingActivityGroupActive(base);
  }
  const cache = hideReasoning ? hiddenReasoningTimelineCache : timelineCache;
  let entry = cache.get(segments);
  if (entry === undefined) {
    entry = {
      base: buildChatActivityTimelineImpl(
        segments,
        EMPTY_PROMOTED_TOOL_BLOCK_IDS,
        hideReasoning,
      ),
      active: null,
    };
    cache.set(segments, entry);
  }
  if (options.turnState === "complete") return entry.base;
  if (entry.active === null) {
    entry.active = markTrailingActivityGroupActive(entry.base);
  }
  return entry.active;
}

function buildChatActivityTimelineImpl(
  segments: ReadonlyArray<MessageSegment>,
  promotedToolBlockIds: ReadonlySet<string>,
  hideReasoning: boolean,
): ReadonlyArray<ChatActivityTimelineItem> {
  const matchedQuestionToolIds = buildMatchedQuestionToolIds(segments);
  const hasQuestionInterview = segments.some(
    (segment) =>
      segment.kind === "interview" &&
      segment.toolName !== null &&
      isKnownInterviewDisplayToolName(segment.toolName),
  );
  const out: ChatActivityTimelineItem[] = [];
  let run: ActivityGroupDetailSegment[] = [];

  // Every run becomes a group, including a run that is one lone reasoning
  // block. #597 special-cased that to a standalone segment to avoid rendering
  // "Thought for Xs" twice (group summary + the child's own header), but a
  // standalone-vs-group decision that can flip mid-turn - the moment a tool
  // call joins the lone block - is exactly the container change this design
  // exists to eliminate.
  //
  // The duplicate IS suppressed for a run that is nothing but one reasoning
  // block (`hidesSoleReasoningHeader`), where the group header's whole label is
  // that block's label. Everywhere else the block keeps its own header: that
  // header carries its label, its collapse on completion and its find anchor,
  // and a group reading "Thought for 2s, ran 3 commands" is NOT standing in for
  // it.
  //
  // Runs SHRINK as well as grow - promotion and suppression both remove members
  // mid-turn, here and upstream in `buildAssistantSegments` - so that rule can
  // flip back. This builder does not try to track it; the component that stays
  // mounted across the shrink does. See `everHeaded` in `ActivityGroupSegment`.
  const flushRun = (): void => {
    if (run.length === 0) return;
    // Reasoning never splits a run, so leaving it out here rather than before
    // grouping draws the same runs, under the id the whole run's first member
    // gives it whether or not that member is reasoning.
    const members = hideReasoning
      ? run.filter((segment) => segment.kind !== "reasoning")
      : run;
    if (members.length > 0) {
      const group = activityGroupFromRun(
        deriveActivityGroupRenderId(run[0].id),
        members,
      );
      out.push({ kind: "activity_group", id: group.id, group });
    }
    run = [];
  };

  for (const segment of segments) {
    if (shouldSuppressInlineSegment(segment)) {
      flushRun();
      continue;
    }
    if (
      isSuppressedQuestionTool(
        segment,
        matchedQuestionToolIds,
        hasQuestionInterview,
      )
    ) {
      continue;
    }
    if (segment.kind === "interview") {
      flushRun();
      out.push({ kind: "segment", id: segment.id, segment });
      continue;
    }
    if (segment.kind === "subagent") {
      flushRun();
      out.push({
        kind: "promoted_subagent",
        id: derivePromotedSubagentRenderId(segment.id),
        segment,
      });
      continue;
    }
    // Either promotion can start returning true MID-TURN for a segment already
    // sitting in a rendered group: the durable marker is fixed, but the host's
    // `backgroundItems` set is transient and grows while the turn runs. The run
    // then splits around a member it used to contain.
    if (
      segment.kind === "tool" &&
      shouldPromoteToolSegment(segment, promotedToolBlockIds)
    ) {
      flushRun();
      out.push({ kind: "segment", id: segment.id, segment });
      continue;
    }
    if (
      segment.kind === "command" &&
      shouldPromoteCommandSegment(segment, promotedToolBlockIds)
    ) {
      flushRun();
      out.push({ kind: "segment", id: segment.id, segment });
      continue;
    }
    if (isActivitySegment(segment)) {
      run.push(segment);
      continue;
    }
    // Everything else - text, errors, plans, etc. - stands on its own in
    // chronological position rather than folding into the activity group.
    // Reasoning is NOT in this bucket at any point in its life.
    flushRun();
    out.push({ kind: "segment", id: segment.id, segment });
  }

  flushRun();
  return out;
}

export function activityGroupSummary(
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): string {
  return activitySummaryOf(segments.flatMap(activitySummaryStepsOf));
}

/** What one segment adds to its group's label (the shared rule, `activitySummaryOf`). */
function activitySummaryStepsOf(
  segment: ActivityGroupDetailSegment,
): ActivitySummaryStep[] {
  switch (segment.kind) {
    case "autonomous_resume":
      return segment.triggers.map((trigger) =>
        trigger.managedCommand?.monitoring === false
          ? { kind: "shell_update" }
          : { kind: "monitor_update" },
      );
    case "reasoning":
      return [
        {
          kind: "reasoning",
          streaming: segment.isStreaming,
          durationMs: segment.durationMs,
        },
      ];
    case "command":
      return [{ kind: "command" }];
    case "file_change":
      return [{ kind: "file_change", filePath: segment.filePath }];
    case "subagent":
      return [{ kind: "subagent" }];
    case "approval":
      return [
        { kind: "approval", approved: segment.decision?.approved === true },
      ];
    case "tool":
      return [
        isMemoryUpdateToolCall({
          ...segment,
          completed: !segment.isStreaming && segment.endState === null,
        })
          ? { kind: "memory_update" }
          : {
              kind: "tool",
              toolName: segment.toolName,
              editKey:
                filePathFromInputDetail(segment.inputDetail) ?? segment.id,
            },
      ];
  }
}

/**
 * True when the group is NOTHING BUT one reasoning block, which then renders
 * without a header row of its own.
 *
 * In that shape the group header's whole label is that block's label verbatim
 * ("Thinking" / "Thought for Xs") - the row said the same thing a second time,
 * one line lower, and kept saying it after the streaming stopped. The thinking
 * clause of `activitySummaryOf` and `reasoningSummaryLabel` are held to producing the same string for the same
 * block precisely so "verbatim" is a fact rather than an approximation.
 *
 * The "nothing but" is load-bearing, not defensive. Keying this on the reasoning
 * count alone also caught the far more common `[reasoning, tool, tool]` shape,
 * where the group header reads "Thought for 2s, ran 3 commands" and is NOT that
 * block's label - so dropping the row left a paragraph of thinking floating
 * between tool rows with no title on it at all. A block only loses its header
 * when the group header is unambiguously standing in for it.
 *
 * PURE FUNCTION OF THE CURRENT SHAPE, and it can flip in BOTH directions - runs
 * do not only grow. A run loses a segment when a command or tool is promoted to
 * the background, when a question tool's interview arrives, and - upstream of
 * this file entirely - when `buildAssistantSegments` suppresses a subagent spawn
 * tool or an edit tool call. The group id comes from the first segment, so
 * `[reasoning, X] -> [reasoning]` happens under an unchanged id.
 *
 * Nothing here tries to detect that. An earlier revision carried a `shrunk` flag
 * on the model and it was wrong twice over: it could not see the removals that
 * happen before the builder runs, and it could not tell "shrank under the
 * reader" from "loaded already this shape", so a message that merely STARTS with
 * a backgrounded command got the duplicate header back forever. The reverse flip
 * is a property of what a group has already SHOWN, so it is handled where that
 * outlives a render - `headedIds` on the activity-group open store.
 *
 * Shared with `chat-find-projection`, which emits a child header unit exactly
 * when this is false - so the units and the ANCHORS agree, and a match is never
 * counted where it cannot be painted.
 */
export function hidesSoleReasoningHeader(
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): boolean {
  return segments.length === 1 && segments[0].kind === "reasoning";
}

/**
 * Whether a run is nothing but reasoning, which makes it Thinking's row rather
 * than Tool activity's: its header reads "Thought for Xs" and opening it shows
 * the trace, so the Thinking setting decides how it opens and what a
 * right-click on it offers.
 */
export function isReasoningOnlyRun(
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): boolean {
  return segments.every((segment) => segment.kind === "reasoning");
}

/**
 * What a reasoning block calls itself, in one place. A streaming block reads
 * "Thinking" and ignores whatever duration it may already carry; a finished one
 * reads its total.
 *
 * The thinking clause of `activitySummaryOf` is held to producing exactly these three strings, lower-cased,
 * for a group whose only segment is one reasoning block - which is the entire
 * basis on which `hidesSoleReasoningHeader` deletes the block's own header.
 */
export function reasoningBlockLabel(
  isStreaming: boolean,
  durationMs: number | null,
): string {
  return isStreaming ? "Thinking" : reasoningSummaryLabel(durationMs);
}

/** The label any activity-group child shows for itself, reasoning included. */
export function activityChildLabel(
  segment: ActivityGroupDetailSegment,
): string {
  if (segment.kind === "reasoning") {
    return reasoningBlockLabel(segment.isStreaming, segment.durationMs);
  }
  return latestActivityLabel(segment);
}

export function latestActivityLabel(segment: ActivitySegment): string {
  switch (segment.kind) {
    case "autonomous_resume":
      return activityLabelLine(
        segment.triggers
          .map((trigger) => `${trigger.title} · ${trigger.summary}`)
          .join(", "),
      );
    case "command":
      return commandActivityLabel(segment.command);
    case "file_change":
      return fileChangeActivityLabel(segment);
    case "subagent":
      return subagentActivityLabel(segment);
    case "approval":
      return approvalActivityLabel(segment);
    case "tool":
      return toolCallActivityLabel(segment.toolName, segment.inputSummary);
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return "Ran activity";
    }
  }
}

function fileChangeActivityLabel(segment: FileChangeSegment): string {
  return `${fileOperationVerb(segment.operation)} ${activityLabelLine(
    segment.filePath,
  )}`;
}

function subagentActivityLabel(segment: SubagentSegment): string {
  const name = segment.name ?? "subagent";
  const task = segment.task ?? segment.result;
  return task === null
    ? `Spawned ${name}`
    : `Spawned ${name}: ${activityLabelLine(task)}`;
}

function approvalActivityLabel(segment: ApprovalSegment): string {
  const label = segment.toolName ?? segment.description ?? "request";
  if (segment.decision === null) return `Requested ${activityLabelLine(label)}`;
  return segment.decision.approved
    ? `Approved ${activityLabelLine(label)}`
    : `Denied ${activityLabelLine(label)}`;
}

/**
 * "This tool call renders as an MCP App row": the host stamped the app it
 * rendered. Keyed on the stamp alone - a harness without app support never
 * stamps, and its call stays an ordinary row in the group.
 */
export function isMcpAppToolCall(call: {
  readonly mcpApp: ToolCallMcpAppStamp | null;
}): boolean {
  return call.mcpApp !== null;
}

function shouldPromoteToolSegment(
  segment: ToolSegment,
  promotedToolBlockIds: ReadonlySet<string>,
): boolean {
  if (segment.toolName === "image_generation") return true;
  if (segment.artifact !== null) return true;
  // An app is the call's result, rendered where the call was made.
  if (isMcpAppToolCall(segment)) return true;
  if (segment.agentMessageSend !== null) return true;
  // A bot's reply, question or announcement is what its
  // session said to people: a send, drawn as its own card. Keyed on the name,
  // which the call has for its whole life, so a send whose input is still
  // streaming or that failed stands on its own as well.
  if (isBotSendToolName(segment.toolName)) return true;
  // A shell the agent ran or restarted (`traycer_run_shell` /
  // `traycer_restart_shell`, host-stamped) is a background process that
  // outlives the turn, exactly what the backgrounded-command rule below is for:
  // its card is the shell's own surface in the feed - live status, the door to
  // its output - and folding it into "Used N tools" would hide the one thing
  // in the group that keeps going after the turn ends. Keyed on the durable
  // block marker, so it holds after reload and for legacy-free stamped blocks.
  if (segment.managedCommand !== null) return true;
  if (segment.imageResults.length > 0) return true;
  // A backgrounded command/Monitor stays a standalone card for its whole life -
  // running, completed, stopped, errored, and after reload - keyed on the
  // persistent block marker. This is the durable signal: it is stamped at birth
  // from the tool input (`run_in_background` / Monitor) and is sticky, so it
  // covers the running phase too. The transient host `backgroundItems` set
  // (`promotedToolBlockIds`) keeps the card live while the host tracks it.
  if (segment.backgroundTask) return true;
  if (promotedToolBlockIds.has(segment.id)) return true;
  // Background-only terminal fallback: some terminal paths surface
  // `backgroundOutput` without the durable marker. Foreground commands never
  // capture background output, so this never promotes them. Deliberately NOT
  // keyed on `isStreaming`/`error` - those fire for foreground commands too and
  // would flash every normal command into a standalone card while it runs,
  // then collapse it back into the activity group on completion.
  return (
    isCommandLikeTool(segment.toolName) && segment.backgroundOutput !== null
  );
}

// A backgrounded command (Codex yields a long-running exec to the background
// and keeps it alive past the turn that started it) stays a standalone card for
// its whole life - running, settled, and after reload - on the same two signals
// as a backgrounded tool call: the durable block marker, and the transient host
// `backgroundItems` set that keeps the card live while the host tracks it.
// There is no `backgroundOutput` fallback here - command stdout is never
// persisted, so the marker is the only durable evidence.
function shouldPromoteCommandSegment(
  segment: CommandSegment,
  promotedToolBlockIds: ReadonlySet<string>,
): boolean {
  if (segment.backgroundTask === true) return true;
  return promotedToolBlockIds.has(segment.id);
}

function isCommandLikeTool(toolName: string): boolean {
  return (
    activityToolKind(toolName) === "run" ||
    normalizedToolName(toolName) === "monitor"
  );
}

function activityGroupFromRun(
  id: string,
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): ActivityGroupModel {
  const summary = activityGroupSummary(segments);
  const isStreaming = segments.some(isStreamingActivitySegment);
  return {
    id,
    segments,
    isActive: isStreaming,
    isStreaming,
    label: summary,
    summary,
    activeStartedAt: activeChildStartedAt(segments),
  };
}

/**
 * Start of the currently-running tool/command (the most recently started still-
 * streaming one - tools run sequentially, so this tracks the current operation).
 * null when nothing nestable is in flight (a streaming subagent/file_change, or
 * a trailing group kept active only because the turn continues, carry no start).
 */
function activeChildStartedAt(
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): number | null {
  let latest: number | null = null;
  for (const segment of segments) {
    if (
      (segment.kind === "tool" || segment.kind === "command") &&
      segment.isStreaming &&
      (latest === null || segment.startedAt > latest)
    ) {
      latest = segment.startedAt;
    }
  }
  return latest;
}

function markTrailingActivityGroupActive(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
): ReadonlyArray<ChatActivityTimelineItem> {
  if (timeline.length === 0) {
    return timeline;
  }
  const last = timeline[timeline.length - 1];
  if (last.kind !== "activity_group" || last.group.isActive) {
    return timeline;
  }
  return [
    ...timeline.slice(0, -1),
    {
      ...last,
      group: {
        ...last.group,
        isActive: true,
      },
    },
  ];
}

function isActivitySegment(
  segment: MessageSegment,
): segment is ActivityGroupDetailSegment {
  if (isMonitorActivitySegment(segment)) return true;
  if (
    segment.kind === "tool" ||
    segment.kind === "command" ||
    segment.kind === "file_change" ||
    segment.kind === "subagent"
  ) {
    return true;
  }
  if (segment.kind === "approval") return segment.decision !== null;
  // Unconditional, streaming included - see `ActivityGroupDetailSegment`. A
  // reasoning block must occupy the same container from its first token to the
  // end of the turn.
  if (segment.kind === "reasoning") return true;
  return false;
}

function isStreamingActivitySegment(
  segment: ActivityGroupDetailSegment,
): boolean {
  if (segment.kind === "approval" || segment.kind === "autonomous_resume")
    return false;
  return segment.isStreaming;
}

function shouldSuppressInlineSegment(segment: MessageSegment): boolean {
  if (segment.kind === "interview" && segment.status === "streaming") {
    return true;
  }
  return segment.kind === "approval" && segment.decision === null;
}

function buildMatchedQuestionToolIds(
  segments: ReadonlyArray<MessageSegment>,
): ReadonlySet<string> {
  let ids: Set<string> | null = null;
  for (const segment of segments) {
    if (segment.kind !== "interview") continue;
    const toolUseId = toolUseIdFromInterviewBlockId(segment.id);
    if (toolUseId === null) continue;
    if (ids === null) ids = new Set();
    ids.add(toolUseId);
  }
  return ids ?? EMPTY_QUESTION_TOOL_IDS;
}

function isSuppressedQuestionTool(
  segment: MessageSegment,
  matchedQuestionToolIds: ReadonlySet<string>,
  hasQuestionInterview: boolean,
): boolean {
  return (
    segment.kind === "tool" &&
    isKnownInterviewDisplayToolName(segment.toolName) &&
    (matchedQuestionToolIds.has(segment.id) || hasQuestionInterview)
  );
}

/**
 * The label a reasoning block shows for itself. Lives here, next to the group
 * clause it has to agree with, and is imported by `ReasoningSegment` (the
 * rendered header) and by `chat-find-projection` (its find unit) so all three
 * spellings of "how long did it think" come from one place.
 *
 * `Math.max(1, ...)` is why: a block that started and finished inside the same
 * millisecond has a real, measured duration of 0 and reads "Thought for 1s",
 * because "Thought for 0s" describes nothing. A block with no measurement at
 * all - persisted history, no `startedAt` - is `null` and reads "Thought".
 */
export function reasoningSummaryLabel(durationMs: number | null): string {
  if (durationMs === null) return "Thought";
  return `Thought for ${thoughtClockDuration(durationMs)}`;
}

function fileOperationVerb(operation: string): string {
  const normalized = operation.toLowerCase();
  if (normalized === "create" || normalized === "add") return "Created";
  if (normalized === "delete" || normalized === "remove") return "Deleted";
  if (normalized === "rename" || normalized === "move") return "Moved";
  return "Edited";
}
