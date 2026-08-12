import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  isKnownInterviewDisplayToolName,
  toolUseIdFromInterviewBlockId,
} from "@traycer/protocol/host/agent/gui/interview-tools";
import { filePathFromInputDetail } from "@/lib/segment-summary";
import { formatClockDuration } from "@/lib/format-duration";
import { formatSingleLine } from "@/lib/utils";
import type {
  ApprovalSegment,
  CommandSegment,
  FileChangeSegment,
  InterviewSegment,
  MessageSegment,
  ReasoningSegment,
  SubagentSegment,
  ToolSegment,
} from "@/stores/composer/chat-store";
import {
  deriveActivityGroupRenderId,
  derivePromotedSubagentRenderId,
} from "./chat-collapsible-key";

export type ActivitySegment =
  | ToolSegment
  | CommandSegment
  | FileChangeSegment
  | SubagentSegment
  | ApprovalSegment;

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
      readonly kind: "answered_questions";
      readonly id: string;
      readonly segment: InterviewSegment;
      readonly summary: string;
    }
  | {
      readonly kind: "promoted_subagent";
      readonly id: string;
      readonly segment: SubagentSegment;
    };

interface ActivitySummaryCounts {
  // Summed duration of every completed reasoning block folded into the group.
  thinkingDurationMs: number;
  // The group contains reasoning AT ALL. Tracked separately from the duration
  // because a completed block can legitimately have none: `completedDurationMs`
  // returns null when the block carries no `startedAt` (persisted history), and
  // 0 when it started and finished inside the same millisecond. Without this,
  // both summed to 0 and the summary fell through to the generic "Ran activity"
  // - losing the "Thought" line the block used to render for itself.
  thinkingPresent: boolean;
  // At least one reasoning block reported a duration. Distinguishes the two
  // ways `thinkingDurationMs` stays 0: a same-millisecond block (a real
  // measurement, which the child renders as "Thought for 1s") from persisted
  // history with no `startedAt` at all (no measurement, "Thought"). Summing
  // alone cannot tell them apart, and the child's own formatter can - which is
  // how the group header and the block it stands in for came to disagree.
  thinkingDurationKnown: boolean;
  // At least one FINISHED block contributed nothing to the sum, so
  // `thinkingDurationMs` is a floor rather than a total. A block is finished
  // with no duration when it was interrupted, superseded or errored (its
  // timestamp is the turn-end, not the real finish) or when it predates
  // `startedAt` - see `completedDurationMs`.
  //
  // The clause marks this with a trailing "+" instead of dropping the number.
  // Dropping it is what a plain "all durations known" check would do, and that
  // walks the label BACKWARDS - `thought for 5s` -> `thought` the moment an
  // interrupted block joins a run that had already measured one. That reverse
  // step is the exact defect `thinkingCompleted` exists to prevent, and it is
  // reachable live, not just in history. A floor only ever grows.
  thinkingDurationPartial: boolean;
  // At least one reasoning block has finished. Once that is true the clause
  // says "thought", never "thinking", however many new blocks start streaming -
  // the header describes the whole run, and a run that has already thought does
  // not stop having done so.
  thinkingCompleted: boolean;
  exploredFiles: number;
  readFiles: number;
  searched: number;
  // Distinct edited-file keys (path when extractable, else the tool-use id).
  // Mutated in place across the single counting pass - the accumulator is built
  // fresh per `activityGroupSummary` call (see `createEmptyCounts`) and never
  // shared, so this avoids the O(n^2) full-Set copy a per-add clone would cost.
  readonly editedFiles: Set<string>;
  ranCommands: number;
  ranHooks: number;
  spawnedSubagents: number;
  approved: number;
  denied: number;
  usedTools: number;
}

type ToolActivityKind =
  "explore" | "read" | "search" | "edit" | "run" | "hook" | "tool";

const SUMMARY_MAX = 96;
const EMPTY_QUESTION_TOOL_IDS: ReadonlySet<string> = new Set();
const EMPTY_PROMOTED_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

export type ActivityTimelineTurnState = "active" | "complete";

export interface ActivityTimelineOptions {
  readonly turnState: ActivityTimelineTurnState;
  readonly promotedToolBlockIds: ReadonlySet<string>;
}

interface TimelineCacheEntry {
  readonly base: ReadonlyArray<ChatActivityTimelineItem>;
  active: ReadonlyArray<ChatActivityTimelineItem> | null;
}

// Timeline is purely a function of `segments`. The base walk is turn-state
// independent — only the trailing-group "active" marker differs — so we cache
// the base once per `segments` identity and derive the active variant on
// demand. This avoids re-walking the same segments tree when the same identity
// is queried for both turn states across renders.
const timelineCache = new WeakMap<
  ReadonlyArray<MessageSegment>,
  TimelineCacheEntry
>();

const READ_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "readfile",
  "view",
  "open_file",
]);

const EXPLORE_TOOL_NAMES = new Set([
  "glob",
  "list",
  "ls",
  "list_files",
  "listfiles",
  "find",
]);

const SEARCH_TOOL_NAMES = new Set([
  "grep",
  "search",
  "rg",
  "web_search",
  "websearch",
  "web_fetch",
  "webfetch",
]);

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "editfile",
  "multi_edit",
  "multiedit",
  "write_file",
  "writefile",
  "apply_patch",
]);

const RUN_TOOL_NAMES = new Set(["bash", "shell", "run_command", "command"]);

function createEmptyCounts(): ActivitySummaryCounts {
  return {
    thinkingDurationMs: 0,
    thinkingPresent: false,
    thinkingDurationKnown: false,
    thinkingDurationPartial: false,
    thinkingCompleted: false,
    exploredFiles: 0,
    readFiles: 0,
    searched: 0,
    editedFiles: new Set(),
    ranCommands: 0,
    ranHooks: 0,
    spawnedSubagents: 0,
    approved: 0,
    denied: 0,
    usedTools: 0,
  };
}

export function buildChatActivityTimeline(
  segments: ReadonlyArray<MessageSegment>,
  options: ActivityTimelineOptions,
): ReadonlyArray<ChatActivityTimelineItem> {
  if (options.promotedToolBlockIds.size > 0) {
    const base = buildChatActivityTimelineImpl(
      segments,
      options.promotedToolBlockIds,
    );
    return options.turnState === "complete"
      ? base
      : markTrailingActivityGroupActive(base);
  }
  let entry = timelineCache.get(segments);
  if (entry === undefined) {
    entry = {
      base: buildChatActivityTimelineImpl(
        segments,
        EMPTY_PROMOTED_TOOL_BLOCK_IDS,
      ),
      active: null,
    };
    timelineCache.set(segments, entry);
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
    const group = activityGroupFromRun(run);
    out.push({ kind: "activity_group", id: group.id, group });
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
      if (segment.status === "completed") {
        out.push({
          kind: "answered_questions",
          id: `answered:${segment.id}`,
          segment,
          summary: answeredQuestionsSummary(segment),
        });
      } else {
        out.push({ kind: "segment", id: segment.id, segment });
      }
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

export function answeredQuestionsSummary(segment: InterviewSegment): string {
  return answeredQuestionsSummaryFromCounts(segment.questions, segment.answers);
}

export function answeredQuestionsSummaryFromCounts(
  questions: ReadonlyArray<InterviewQuestion>,
  answers: ReadonlyArray<InterviewAnswer>,
): string {
  const total = questions.length > 0 ? questions.length : answers.length;
  const answered = answers.filter(answerHasValues).length;
  return formatAnsweredQuestionsSummary(answered, total);
}

function answerHasValues(answer: InterviewAnswer): boolean {
  return answer.values.length > 0;
}

function formatAnsweredQuestionsSummary(
  answered: number,
  total: number,
): string {
  if (answered === total) {
    return `Answered ${answered} ${answered === 1 ? "question" : "questions"}`;
  }
  return `Answered ${answered}/${total} questions`;
}

export function activityGroupSummary(
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): string {
  const counts = createEmptyCounts();
  segments.forEach((segment) => countActivitySegment(counts, segment));
  const parts = [
    thinkingPhrase(counts),
    countPhrase(counts.exploredFiles, "explored", "file", "files"),
    countPhrase(counts.readFiles, "read", "file", "files"),
    countPhrase(counts.searched, "searched", "place", "places"),
    countPhrase(counts.editedFiles.size, "edited", "file", "files"),
    countPhrase(counts.ranCommands, "ran", "command", "commands"),
    countPhrase(counts.ranHooks, "ran", "hook", "hooks"),
    countPhrase(counts.spawnedSubagents, "spawned", "subagent", "subagents"),
    countPhrase(counts.approved, "approved", "request", "requests"),
    countPhrase(counts.denied, "denied", "request", "requests"),
    countPhrase(counts.usedTools, "used", "tool", "tools"),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return "Ran activity";
  return capitalizeFirst(parts.join(", "));
}

/**
 * True when the group is NOTHING BUT one reasoning block, which then renders
 * without a header row of its own.
 *
 * In that shape the group header's whole label is that block's label verbatim
 * ("Thinking" / "Thought for Xs") - the row said the same thing a second time,
 * one line lower, and kept saying it after the streaming stopped. `thinkingPhrase`
 * and `reasoningSummaryLabel` are held to producing the same string for the same
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
 * What a reasoning block calls itself, in one place. A streaming block reads
 * "Thinking" and ignores whatever duration it may already carry; a finished one
 * reads its total.
 *
 * `thinkingPhrase` is held to producing exactly these three strings, lower-cased,
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
    case "command":
      return commandActivityLabel(segment);
    case "file_change":
      return fileChangeActivityLabel(segment);
    case "subagent":
      return subagentActivityLabel(segment);
    case "approval":
      return approvalActivityLabel(segment);
    case "tool":
      return toolActivityLabel(segment);
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return "Ran activity";
    }
  }
}

function commandActivityLabel(segment: CommandSegment): string {
  return `Ran ${singleLine(segment.command)}`;
}

function fileChangeActivityLabel(segment: FileChangeSegment): string {
  return `${fileOperationVerb(segment.operation)} ${singleLine(
    segment.filePath,
  )}`;
}

function subagentActivityLabel(segment: SubagentSegment): string {
  const name = segment.name ?? "subagent";
  const task = segment.task ?? segment.result;
  return task === null
    ? `Spawned ${name}`
    : `Spawned ${name}: ${singleLine(task)}`;
}

function approvalActivityLabel(segment: ApprovalSegment): string {
  const label = segment.toolName ?? segment.description ?? "request";
  if (segment.decision === null) return `Requested ${singleLine(label)}`;
  return segment.decision.approved
    ? `Approved ${singleLine(label)}`
    : `Denied ${singleLine(label)}`;
}

function shouldPromoteToolSegment(
  segment: ToolSegment,
  promotedToolBlockIds: ReadonlySet<string>,
): boolean {
  if (segment.toolName === "image_generation") return true;
  if (segment.agentMessageSend !== null) return true;
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
  const normalized = normalizedToolName(toolName);
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "monitor" ||
    RUN_TOOL_NAMES.has(normalized)
  );
}

function toolActivityLabel(segment: ToolSegment): string {
  const toolKind = toolActivityKind(segment.toolName);
  const summary = segment.inputSummary;
  const detail = summary === null ? segment.toolName : summary;
  switch (toolKind) {
    case "read":
      return `Read ${singleLine(detail)}`;
    case "explore":
      return `Explored ${singleLine(detail)}`;
    case "search":
      return `Searched ${singleLine(detail)}`;
    case "edit":
      return `Edited ${singleLine(detail)}`;
    case "run":
      return `Ran ${singleLine(detail)}`;
    case "hook":
      return `Ran ${singleLine(segment.toolName)}`;
    case "tool":
      return `Used ${singleLine(detail)}`;
    default: {
      const _exhaustive: never = toolKind;
      void _exhaustive;
      return `Used ${singleLine(detail)}`;
    }
  }
}

function activityGroupFromRun(
  segments: ReadonlyArray<ActivityGroupDetailSegment>,
): ActivityGroupModel {
  const first = segments[0];
  const summary = activityGroupSummary(segments);
  const isStreaming = segments.some(isStreamingActivitySegment);
  return {
    id: deriveActivityGroupRenderId(first.id),
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
  if (segment.kind === "approval") return false;
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

function countActivitySegment(
  counts: ActivitySummaryCounts,
  segment: ActivityGroupDetailSegment,
): void {
  if (segment.kind === "reasoning") {
    countReasoningSegment(counts, segment);
    return;
  }
  if (segment.kind === "command") {
    counts.ranCommands += 1;
    return;
  }
  if (segment.kind === "file_change") {
    counts.editedFiles.add(segment.filePath);
    return;
  }
  if (segment.kind === "subagent") {
    counts.spawnedSubagents += 1;
    return;
  }
  if (segment.kind === "approval") {
    if (segment.decision?.approved === true) counts.approved += 1;
    else counts.denied += 1;
    return;
  }

  const kind = toolActivityKind(segment.toolName);
  if (kind === "explore") {
    counts.exploredFiles += 1;
    return;
  }
  if (kind === "read") {
    counts.readFiles += 1;
    return;
  }
  if (kind === "search") {
    counts.searched += 1;
    return;
  }
  if (kind === "edit") {
    counts.editedFiles.add(
      filePathFromInputDetail(segment.inputDetail) ?? segment.id,
    );
    return;
  }
  if (kind === "run") {
    counts.ranCommands += 1;
    return;
  }
  if (kind === "hook") {
    counts.ranHooks += 1;
    return;
  }
  counts.usedTools += 1;
}

function toolActivityKind(toolName: string): ToolActivityKind {
  const normalized = normalizedToolName(toolName);
  if (normalized.includes("hook")) return "hook";
  if (READ_TOOL_NAMES.has(normalized)) return "read";
  if (EXPLORE_TOOL_NAMES.has(normalized)) return "explore";
  if (SEARCH_TOOL_NAMES.has(normalized)) return "search";
  if (EDIT_TOOL_NAMES.has(normalized)) return "edit";
  if (RUN_TOOL_NAMES.has(normalized)) return "run";
  return "tool";
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[\s.-]+/g, "_");
}

function countPhrase(
  count: number,
  verb: string,
  singular: string,
  plural: string,
): string | null {
  if (count === 0) return null;
  return `${verb} ${count} ${count === 1 ? singular : plural}`;
}

/**
 * Split out of `countActivitySegment` purely to keep that switch under the
 * complexity ceiling - reasoning is the one child kind that contributes two
 * independent facts to the summary rather than a single count.
 */
function countReasoningSegment(
  counts: ActivitySummaryCounts,
  segment: ReasoningSegment,
): void {
  counts.thinkingPresent = true;
  if (segment.isStreaming) {
    // A block still streaming contributes nothing but its presence, even if it
    // already carries a duration: `ReasoningSegment` labels a streaming block
    // "Thinking" and ignores the number, so counting it here would let the
    // group say "Thought for 3s" over a child still saying "Thinking" - and
    // `hidesSoleReasoningHeader` would then hide a header that did NOT say the
    // same thing.
    return;
  }
  counts.thinkingCompleted = true;
  if (segment.durationMs === null) {
    // Finished, but unmeasurable - interrupted, superseded, errored, or older
    // than `startedAt`. The sum it does not join stops being a total.
    counts.thinkingDurationPartial = true;
    return;
  }
  counts.thinkingDurationKnown = true;
  counts.thinkingDurationMs += segment.durationMs;
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

/**
 * The ONE place a thinking duration becomes a string. `reasoningSummaryLabel`
 * (the block's own header) and `thinkingPhrase` (the group clause standing in
 * for it) both route through here, so the equality `hidesSoleReasoningHeader`
 * bets on is structural rather than two copies of a rounding rule kept in step
 * by hand.
 *
 * `Math.max(1, ...)` is why the rule needs a home: a block that started and
 * finished inside the same millisecond has a real, measured duration of 0 and
 * reads "1s", because "0s" describes nothing. A block with no measurement at
 * all is `null` and never reaches here.
 */
function thoughtClockDuration(durationMs: number): string {
  return formatClockDuration(Math.max(1, Math.round(durationMs / 1000)));
}

/**
 * Leading clause of a group summary that contains reasoning.
 *
 * MONOTONE: `thinking` -> `thought` -> `thought for Xs`, and never backwards.
 * None of the three flags it reads can clear (reasoning is the one child kind
 * that never leaves a run), so the clause can only move forward.
 *
 * Two revisions got this wrong in the same way - by letting a NEW streaming
 * block erase what the run had already done. First a bare "thinking" whenever
 * anything streamed, which shuttled `Thought for 5s, read 3 files` ->
 * `Thinking` -> `Thought for 11s, read 3 files`. Then a duration-only guard,
 * which fixed that everywhere except history with no `startedAt`: total 0,
 * `thought` -> `thinking` -> `thought` on the next block. `thinkingCompleted`
 * closes it - a run that has already thought does not stop having done so.
 *
 * The three branches are exactly `reasoningSummaryLabel`'s three cases, in
 * lower case, and must stay that way: for a group whose only segment is one
 * reasoning block this string IS the whole label, and
 * `hidesSoleReasoningHeader` drops the block's own header on the strength of
 * the two being identical.
 *
 * The "+" suffix is the one thing here `reasoningSummaryLabel` has no analogue
 * for, and it CANNOT break that equality: it needs one finished block with a
 * duration and another without, which is two segments, and a group of two
 * segments is never headerless.
 */
function thinkingPhrase(counts: ActivitySummaryCounts): string | null {
  if (!counts.thinkingPresent) return null;
  if (counts.thinkingDurationKnown) {
    const clause = `thought for ${thoughtClockDuration(counts.thinkingDurationMs)}`;
    // A floor, not a total - some finished block could not be measured.
    return counts.thinkingDurationPartial ? `${clause}+` : clause;
  }
  if (counts.thinkingCompleted) return "thought";
  return "thinking";
}

function capitalizeFirst(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function singleLine(value: string): string {
  return formatSingleLine(value, {
    maxLength: SUMMARY_MAX,
    ellipsis: "...",
  });
}

function fileOperationVerb(operation: string): string {
  const normalized = operation.toLowerCase();
  if (normalized === "create" || normalized === "add") return "Created";
  if (normalized === "delete" || normalized === "remove") return "Deleted";
  if (normalized === "rename" || normalized === "move") return "Moved";
  return "Edited";
}
