import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  isKnownInterviewDisplayToolName,
  toolUseIdFromInterviewBlockId,
} from "@traycer/protocol/host/agent/gui/interview-tools";
import { filePathFromInputDetail } from "@/lib/segment-summary";
import { formatSingleLine } from "@/lib/utils";
import type {
  ApprovalSegment,
  CommandSegment,
  FileChangeSegment,
  InterviewSegment,
  MessageSegment,
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

// Reasoning is promoted to its own inline segment; activity groups carry only
// operational activity.
export type ActivityGroupDetailSegment = ActivitySegment;

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
  const out: ChatActivityTimelineItem[] = [];
  let run: ActivityGroupDetailSegment[] = [];

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
    if (isSuppressedQuestionTool(segment, matchedQuestionToolIds)) {
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
    if (
      segment.kind === "tool" &&
      shouldPromoteToolSegment(segment, promotedToolBlockIds)
    ) {
      flushRun();
      out.push({ kind: "segment", id: segment.id, segment });
      continue;
    }
    if (isActivitySegment(segment)) {
      run.push(segment);
      continue;
    }
    // Everything else - reasoning (now a first-class inline segment), text,
    // etc. - stands on its own in chronological position rather than folding
    // into the operational activity group.
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
): segment is ActivitySegment {
  if (
    segment.kind === "tool" ||
    segment.kind === "command" ||
    segment.kind === "file_change" ||
    segment.kind === "subagent"
  ) {
    return true;
  }
  return segment.kind === "approval" && segment.decision !== null;
}

function isStreamingActivitySegment(segment: ActivitySegment): boolean {
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
): boolean {
  return (
    segment.kind === "tool" &&
    matchedQuestionToolIds.has(segment.id) &&
    isKnownInterviewDisplayToolName(segment.toolName)
  );
}

function countActivitySegment(
  counts: ActivitySummaryCounts,
  segment: ActivitySegment,
): void {
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
