import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import {
  answeredQuestionsSummary,
  buildChatActivityTimeline,
} from "@/components/chat/chat-activity-groups";
import {
  deriveA2AReceivedCollapsibleKey,
  deriveA2ASendCollapsibleKey,
  deriveActivityGroupCollapsibleKey,
  derivePromotedSubagentRenderId,
  deriveSubagentCollapsibleKey,
  type ChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import {
  adjacentDedupedProgressItems,
  cleanSubagentNotificationText,
} from "@/components/chat/segments/subagent-display";
import { parseTraycerNextStepsMarkdown } from "@/markdown/traycer-next-steps";
import { composerClipboardPlainText } from "@/lib/composer/composer-clipboard";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";
import { segmentStepLabel } from "@/lib/chat/todo-status-tones";
import {
  PLAN_PREVIEW_STEP_LIMIT,
  planCardSubtitle,
  planFallbackMarkdown,
  planHeadline,
  planStatusBadgeLabel,
} from "@/components/chat/segments/plan-display";
import { formatClockDuration } from "@/lib/format-duration";
import { formatSingleLine } from "@/lib/utils";
import type {
  ActivityGroupModel,
  ChatActivityTimelineItem,
} from "@/components/chat/chat-activity-groups";
import type {
  ChatMessage as ChatMessageModel,
  CommandSegment,
  FileChangeSegment,
  InterviewSegment,
  MessageSegment,
  PlanSegmentModel,
  SubagentSegment,
  ToolSegment,
} from "@/stores/composer/chat-store";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindInput,
  TileFindStateSnapshot,
  TileReplaceInput,
} from "@/stores/tile-find";

export interface ChatFindRow {
  readonly messageId: string;
  readonly units: ReadonlyArray<ChatFindUnit>;
}

export interface ChatFindUnit {
  readonly unitId: string;
  readonly text: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
}

export interface ChatFindAdapter extends TileFindAdapter {
  updateRows(rows: ReadonlyArray<ChatFindRow>): void;
  syncMountedHighlight(): void;
  dispose(): void;
}

interface ChatFindAdapterOptions {
  readonly tileInstanceId: string;
  readonly revealMatch: (target: ChatFindRevealTarget) => void;
  readonly reconcileMatch: (target: ChatFindReconcileTarget) => void;
  readonly clearReveal: () => void;
  readonly getMountedMessageRoot: (messageId: string) => HTMLElement | null;
  readonly getMountedUnitRoot: (
    messageId: string,
    unitId: string,
  ) => HTMLElement | null;
}

export interface ChatFindRevealTarget {
  readonly messageId: string;
  readonly unitId: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
  readonly matchKey: string;
  readonly paint: () => void;
  readonly paintFallback: () => void;
}

export interface ChatFindReconcileTarget {
  readonly messageId: string;
  readonly unitId: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
  readonly matchKey: string;
}

interface ChatFindMatch {
  readonly messageId: string;
  readonly rowIndex: number;
  readonly unitId: string;
  readonly unitIndex: number;
  readonly start: number;
  readonly end: number;
  // Occurrence ordinal within the match's own unit. Drives the unit-scope paint
  // and the match key.
  readonly occurrenceInUnit: number;
  // Occurrence ordinal across the WHOLE message (all units, in render order).
  // Drives the message-scope fallback paint, whose root walks every unit - the
  // per-unit ordinal would point at the wrong occurrence there.
  readonly occurrenceInMessage: number;
  // Surrounding unit text immediately before/after this occurrence (capped to a
  // small window). Used to re-anchor the active match across mid-unit streaming
  // inserts, where neither the occurrence ordinal nor the absolute offset is
  // stable but the immediate neighbours are.
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
}

interface SupportedHighlightsAPI {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
}

interface HighlightNames {
  readonly match: string;
  readonly active: string;
}

const CHAT_FIND_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>(["find"]);
const EMPTY_MATCHES: ReadonlyArray<ChatFindMatch> = [];
const BUILT_IN_MARKED_TOKEN_TYPES = [
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
] as const;
const SKIPPED_HIGHLIGHT_ANCESTOR_SELECTOR = [
  "[data-find-skip]",
  "input",
  "textarea",
  "select",
  "script",
  "style",
  "noscript",
  "svg",
  "title",
  "[hidden]",
  "[data-slot='collapsible-content'][data-state='closed']",
  ".sr-only",
  "[aria-hidden='true']",
].join(",");
const INCLUDED_BUTTON_HIGHLIGHT_SELECTOR = "button[data-find-include='true']";
const CHAT_FIND_PREVIEW_MAX_LENGTH = 180;
// How much neighbouring unit text to snapshot on each side of an occurrence for
// active-match re-anchoring across streaming inserts. Long enough to
// disambiguate occurrences of the same query, short enough to ignore edits that
// land elsewhere in the (often concatenated) unit.
const FIND_RECONCILE_CONTEXT_WINDOW = 32;

export function buildChatFindRows(
  messages: ReadonlyArray<ChatMessageModel>,
  tileInstanceId: string,
): ReadonlyArray<ChatFindRow> {
  return messages.map((message) => {
    const units = chatFindUnitsForMessage(message, tileInstanceId);
    return {
      messageId: message.id,
      units,
    };
  });
}

export function markdownToChatSearchText(markdown: string): string {
  return normalizeSearchableText(tokensToText(lexer(markdown, { gfm: true })));
}

export function createChatFindAdapter(
  options: ChatFindAdapterOptions,
): ChatFindAdapter {
  return new ChatFindAdapterImpl(options);
}

export function chatFindMessageContentUnitId(messageId: string): string {
  return `message:${messageId}:content`;
}

export function chatFindSegmentUnitId(segmentId: string): string {
  return `segment:${segmentId}`;
}

export function chatFindActivityGroupSummaryUnitId(groupId: string): string {
  return `activity-group:${groupId}:summary`;
}

export function chatFindActivityGroupChildHeaderUnitId(
  groupId: string,
  segmentId: string,
): string {
  return `activity-group:${groupId}:child:${segmentId}:header`;
}

export function chatFindSubagentHeaderUnitId(renderId: string): string {
  return `subagent:${renderId}:header`;
}

export function chatFindSubagentBodyUnitId(renderId: string): string {
  return `subagent:${renderId}:body`;
}

export function chatFindA2ASendBodyUnitId(segmentId: string): string {
  return `a2a-send:${segmentId}:body`;
}

export function chatFindA2AReceivedBodyUnitId(messageId: string): string {
  return `a2a-received:${messageId}:body`;
}

function chatFindUnitsForMessage(
  message: ChatMessageModel,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  if (message.role === "assistant") {
    const turnState = message.runState === null ? "complete" : "active";
    // Find indexes the full transcript inline regardless of background
    // promotion, so no tool blocks are treated as promoted here.
    return buildChatActivityTimeline(message.segments, {
      turnState,
      promotedToolBlockIds: new Set<string>(),
    }).flatMap((item) => timelineItemSearchUnits(item, tileInstanceId));
  }

  if (message.role === "user" && message.agentSenderInfo !== null) {
    return compactUnits([
      chatFindUnit({
        unitId: chatFindA2AReceivedBodyUnitId(message.id),
        text: markdownToChatSearchText(message.content),
        owningChain: [
          deriveA2AReceivedCollapsibleKey(tileInstanceId, message.id),
        ],
      }),
    ]);
  }

  const contentText =
    message.structuredContent === null
      ? message.content
      : composerClipboardPlainText(message.structuredContent);
  return compactUnits([
    chatFindUnit({
      unitId: chatFindMessageContentUnitId(message.id),
      text: contentText,
      owningChain: [],
    }),
    ...message.segments.flatMap((segment) =>
      segmentSearchUnits(segment, tileInstanceId),
    ),
  ]);
}

function timelineItemSearchUnits(
  item: ChatActivityTimelineItem,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  if (item.kind === "segment") {
    return segmentSearchUnits(item.segment, tileInstanceId);
  }
  if (item.kind === "answered_questions") {
    return compactUnits([
      chatFindUnit({
        unitId: chatFindSegmentUnitId(item.segment.id),
        text: item.summary,
        owningChain: [],
      }),
    ]);
  }
  if (item.kind === "promoted_subagent") {
    const renderId = derivePromotedSubagentRenderId(item.segment.id);
    return subagentSegmentSearchUnits(
      item.segment,
      renderId,
      [],
      deriveSubagentCollapsibleKey(tileInstanceId, renderId),
    );
  }
  return activityGroupSearchUnits(item.group, tileInstanceId);
}

function activityGroupSearchUnits(
  group: ActivityGroupModel,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  const groupKey = deriveActivityGroupCollapsibleKey(tileInstanceId, group.id);
  return compactUnits([
    chatFindUnit({
      unitId: chatFindActivityGroupSummaryUnitId(group.id),
      text: group.label,
      owningChain: [],
    }),
    ...group.segments.flatMap((segment) =>
      activityGroupChildSearchUnits(
        segment,
        group.id,
        [groupKey],
        tileInstanceId,
      ),
    ),
  ]);
}

function activityGroupChildSearchUnits(
  segment: ActivityGroupModel["segments"][number],
  groupId: string,
  groupChain: ReadonlyArray<ChatCollapsibleKey>,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  if (segment.kind === "subagent") {
    const renderId = segment.id;
    return subagentSegmentSearchUnits(
      segment,
      renderId,
      groupChain,
      deriveSubagentCollapsibleKey(tileInstanceId, renderId),
    );
  }
  if (segment.kind === "tool" && segment.agentMessageSend !== null) {
    return compactUnits([
      chatFindUnit({
        unitId: chatFindA2ASendBodyUnitId(segment.id),
        text: markdownToChatSearchText(segment.agentMessageSend.message),
        owningChain: [
          ...groupChain,
          deriveA2ASendCollapsibleKey(tileInstanceId, segment.id),
        ],
      }),
    ]);
  }

  return compactUnits([
    chatFindUnit({
      unitId: chatFindActivityGroupChildHeaderUnitId(groupId, segment.id),
      text: activityGroupChildHeaderSearchText(segment).join("\n"),
      owningChain: groupChain,
    }),
  ]);
}

function chatFindUnit(args: {
  readonly unitId: string;
  readonly text: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
}): ChatFindUnit | null {
  const text = normalizeSearchableText(args.text);
  if (text.length === 0) return null;
  return {
    unitId: args.unitId,
    text,
    owningChain: args.owningChain,
  };
}

function compactUnits(
  units: ReadonlyArray<ChatFindUnit | null>,
): ReadonlyArray<ChatFindUnit> {
  return units.filter((unit): unit is ChatFindUnit => unit !== null);
}

function segmentSearchUnits(
  segment: MessageSegment,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  if (segment.kind === "subagent") {
    const renderId = segment.id;
    return subagentSegmentSearchUnits(
      segment,
      renderId,
      [],
      deriveSubagentCollapsibleKey(tileInstanceId, renderId),
    );
  }
  if (segment.kind === "tool" && segment.agentMessageSend !== null) {
    return compactUnits([
      chatFindUnit({
        unitId: chatFindA2ASendBodyUnitId(segment.id),
        text: markdownToChatSearchText(segment.agentMessageSend.message),
        owningChain: [deriveA2ASendCollapsibleKey(tileInstanceId, segment.id)],
      }),
    ]);
  }

  return compactUnits([
    chatFindUnit({
      unitId: chatFindSegmentUnitId(segment.id),
      text: segmentSearchText(segment).join("\n"),
      owningChain: [],
    }),
  ]);
}

// The branch count mirrors the persisted chat segment taxonomy.
// eslint-disable-next-line complexity
function segmentSearchText(segment: MessageSegment): ReadonlyArray<string> {
  switch (segment.kind) {
    case "text":
      return parseTraycerNextStepsMarkdown(
        segment.markdown,
        segment.isStreaming,
      ).flatMap((part) => {
        if (part.kind === "markdown") {
          return [markdownToChatSearchText(part.markdown)];
        }
        return [markdownToChatSearchText(part.prose)];
      });
    case "reasoning":
      return reasoningSegmentSearchText(segment);
    case "tool":
      return toolSegmentSearchText(segment);
    case "file_change":
      return fileChangeSegmentSearchText(segment);
    case "file_change_group":
      return [fileChangeGroupSearchText(segment)];
    case "command":
      return commandSegmentSearchText(segment);
    case "subagent":
      return subagentBodySearchText(segment);
    case "approval":
      // Mirror the rendered header label: verdict + (toolName ?? description ??
      // "approval"). `description`/`reason` live only in the unanchored body, so
      // indexing them would count matches that can never paint.
      return [
        segment.decision?.approved === true ? "Approved" : "Denied",
        segment.toolName ?? segment.description ?? "approval",
      ];
    case "artifact_operation":
      return [
        normalizeSearchableText(
          [
            artifactOperationVerb(segment.operation),
            segment.artifactKind,
            segment.title ?? "",
          ].join(" "),
        ),
      ];
    case "plan":
      return planSegmentSearchText(segment);
    case "todo":
      return todoSegmentSearchText(segment);
    case "error":
      return [
        normalizeSearchableText([segment.message, segment.code].join(" ")),
      ];
    case "compaction":
      return [
        normalizeSearchableText(
          [segment.summary ?? "", segment.error ?? "", segment.status].join(
            " ",
          ),
        ),
      ];
    case "interview":
      return interviewSegmentSearchText(segment);
    case "forked-chat-link":
      return [
        normalizeSearchableText(`Forked from ${segment.sourceChatTitle}`),
      ];
    case "setup-card":
      return [
        normalizeSearchableText(
          [
            "Workspace setup",
            segment.model.aggregate.state,
            ...segment.model.workspaces.flatMap((workspace) => [
              workspace.label,
              workspace.workspacePath,
              workspace.worktreePath ?? "",
              workspace.branch ?? "",
              workspace.state,
            ]),
          ].join(" "),
        ),
      ];
    case "autonomous_resume":
      // Not find-indexed: the autonomous-resume card carries no find-unit
      // anchor, so indexing it would count matches that cannot be highlighted.
      return [];
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return [];
    }
  }
}

function activityGroupChildHeaderSearchText(
  segment: ActivityGroupModel["segments"][number],
): ReadonlyArray<string> {
  switch (segment.kind) {
    case "tool":
      return toolSegmentSearchText(segment);
    case "command":
      return commandSegmentSearchText(segment);
    case "file_change":
      return fileChangeSegmentSearchText(segment);
    case "approval":
      // Same parity rule as the top-level approval projection above: only the
      // verdict + header label are rendered (body is unanchored).
      return [
        segment.decision?.approved === true ? "Approved" : "Denied",
        segment.toolName ?? segment.description ?? "approval",
      ];
    case "subagent":
      return [];
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return [];
    }
  }
}

function toolSegmentSearchText(segment: ToolSegment): ReadonlyArray<string> {
  if (segment.agentMessageSend !== null) {
    return [
      normalizeSearchableText(
        [
          "Sent message",
          formatSingleLine(segment.agentMessageSend.message, {
            maxLength: CHAT_FIND_PREVIEW_MAX_LENGTH,
            ellipsis: "…",
          }),
        ].join(" "),
      ),
    ];
  }
  return [
    normalizeSearchableText(
      [
        segment.toolName,
        segment.inputSummary ?? "",
        segment.error === null || segment.error.length === 0 ? "" : "error",
      ].join(" "),
    ),
  ];
}

function fileChangeSegmentSearchText(
  segment: FileChangeSegment,
): ReadonlyArray<string> {
  return [
    normalizeSearchableText(
      [
        fileChangeVerb(segment.operation),
        segment.filePath,
        `+${segment.additions}`,
        `-${segment.deletions}`,
      ].join(" "),
    ),
  ];
}

function fileChangeGroupSearchText(
  segment: Extract<MessageSegment, { kind: "file_change_group" }>,
): string {
  const additions = segment.files.reduce(
    (total, file) => total + file.additions,
    0,
  );
  const deletions = segment.files.reduce(
    (total, file) => total + file.deletions,
    0,
  );
  return normalizeSearchableText(
    [
      "Changes",
      changeCountLabel(segment.files.length, segment.artifacts.length),
      additions > 0 ? `+${additions}` : "",
      deletions > 0 ? `-${deletions}` : "",
    ].join(" "),
  );
}

function commandSegmentSearchText(
  segment: CommandSegment,
): ReadonlyArray<string> {
  return [normalizeSearchableText(segment.command)];
}

// A subagent renders TWO independently-visible regions, so it projects to two
// find units:
//   - header (name + agent type): always visible while the parent is open, so
//     its owning chain is the PARENT chain - it must stay findable even when the
//     subagent's own body is collapsed.
//   - body (task + progress + result): inside the subagent's own collapsible, so
//     its chain additionally includes the subagent's own key.
function subagentSegmentSearchUnits(
  segment: SubagentSegment,
  renderId: string,
  parentChain: ReadonlyArray<ChatCollapsibleKey>,
  ownKey: ChatCollapsibleKey,
): ReadonlyArray<ChatFindUnit> {
  return compactUnits([
    chatFindUnit({
      unitId: chatFindSubagentHeaderUnitId(renderId),
      text: subagentHeaderSearchText(segment),
      owningChain: parentChain,
    }),
    chatFindUnit({
      unitId: chatFindSubagentBodyUnitId(renderId),
      text: subagentBodySearchText(segment).join("\n"),
      owningChain: [...parentChain, ownKey],
    }),
  ]);
}

// The always-visible header line: the cleaned display name (falling back to the
// rendered "Subagent" placeholder) plus the cleaned agent-type badge text.
function subagentHeaderSearchText(segment: SubagentSegment): string {
  return [
    cleanSubagentNotificationText(segment.name) ?? "Subagent",
    cleanSubagentNotificationText(segment.agentType) ?? "",
  ].join(" ");
}

function subagentBodySearchText(
  segment: SubagentSegment,
): ReadonlyArray<string> {
  return [
    cleanSubagentNotificationText(segment.task) ?? "",
    // Progress is rendered raw and adjacent-deduped; index the SAME deduped raw
    // lines so the counter matches the rendered list (no phantom duplicates).
    ...adjacentDedupedProgressItems(segment.progressUpdates).map(
      (item) => item.text,
    ),
    segment.result === null ? "" : markdownToChatSearchText(segment.result),
  ];
}

// Reasoning is intentionally summary-only: the find unit is the header BUTTON,
// whose only text is this label ("Thinking" while streaming, "Thought for Xs"
// once done). The streaming tail and the expanded full trace render in a SIBLING
// element OUTSIDE the find-unit anchor, so they are neither paintable nor
// counted - indexing them would be a phantom match. Keep this in lockstep with
// the button label in `reasoning-segment.tsx`.
function reasoningSegmentSearchText(
  segment: Extract<MessageSegment, { kind: "reasoning" }>,
): ReadonlyArray<string> {
  if (segment.isStreaming) return ["Thinking"];
  return [reasoningSummaryLabel(segment.durationMs)];
}

// Index ONLY what the inline plan card renders: the headline, the status badge
// label (suppressed for awaiting_approval), the optional subtitle, and the first
// N step labels. The full markdown preview and the remaining steps live behind
// an unopened dialog, so indexing them would over-count un-findable matches.
function planSegmentSearchText(
  segment: PlanSegmentModel,
): ReadonlyArray<string> {
  const cardHeadline = planHeadline(segment, planFallbackMarkdown(segment));
  return [
    normalizeSearchableText(
      [
        cardHeadline,
        planStatusBadgeLabel(segment.planStatus) ?? "",
        planCardSubtitle(segment, cardHeadline) ?? "",
        ...segment.steps
          .slice(0, PLAN_PREVIEW_STEP_LIMIT)
          .map((step) => segmentStepLabel(step)),
      ].join(" "),
    ),
  ];
}

// The todo card renders a "<done> of <total> Done" header line and one
// status-aware label per item. The status / priority words are NOT rendered, so
// they must not be indexed (they were phantom matches before).
function todoSegmentSearchText(
  segment: Extract<MessageSegment, { kind: "todo" }>,
): ReadonlyArray<string> {
  const done = segment.items.filter(
    (item) => item.status === "completed",
  ).length;
  return [
    `${done} of ${segment.items.length} Done`,
    ...segment.items.map((item) => segmentStepLabel(item)),
  ];
}

function interviewSegmentSearchText(
  segment: InterviewSegment,
): ReadonlyArray<string> {
  if (segment.status === "streaming") return [];
  if (segment.status === "errored") return ["Question failed"];
  return [answeredQuestionsSummary(segment)];
}

function tokensToText(tokens: ReadonlyArray<Token>): string {
  return tokens
    .flatMap((token) => {
      const text = tokenToText(token);
      return text.length > 0 ? [text] : [];
    })
    .join("\n");
}

// The branch count follows marked's token union.
// eslint-disable-next-line complexity
function tokenToText(token: Token): string {
  if (!isBuiltInMarkedToken(token)) return "";

  switch (token.type) {
    case "space":
    case "hr":
    case "def":
    case "html":
    case "br":
      return "";
    case "code":
    case "codespan":
    case "escape":
    case "text":
      return token.text;
    case "image":
      return token.text;
    case "blockquote":
    case "del":
    case "em":
    case "heading":
    case "link":
    case "paragraph":
    case "strong":
      return tokensToText(token.tokens);
    case "list":
      return token.items.map(tokenToText).join("\n");
    case "list_item":
      return tokensToText(token.tokens);
    case "checkbox":
      return token.checked ? "checked" : "unchecked";
    case "table":
      return tableToText(token);
    default:
      return "";
  }
}

function tableToText(token: Tokens.Table): string {
  return [
    ...token.header.map((cell) => tokensToText(cell.tokens)),
    ...token.rows.flatMap((row) =>
      row.map((cell) => tokensToText(cell.tokens)),
    ),
  ].join("\n");
}

function isBuiltInMarkedToken(token: Token): token is MarkedToken {
  return BUILT_IN_MARKED_TOKEN_TYPES.some((type) => type === token.type);
}

function normalizeSearchableText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fileChangeVerb(operation: string): string {
  switch (operation) {
    case "delete":
      return "Delete";
    case "create":
      return "Create";
    case "ambiguous":
      return "Write";
    default:
      return "Edit";
  }
}

function changeCountLabel(fileCount: number, artifactCount: number): string {
  const parts: string[] = [];
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`);
  }
  if (artifactCount > 0) {
    parts.push(`${artifactCount} artifact${artifactCount > 1 ? "s" : ""}`);
  }
  return parts.join(" ");
}

function reasoningSummaryLabel(durationMs: number | null): string {
  if (durationMs === null) return "Thought";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `Thought for ${formatClockDuration(seconds)}`;
}

class ChatFindAdapterImpl implements ChatFindAdapter {
  readonly tileInstanceId: string;
  readonly tileKind = "chat" as const;

  private readonly revealMatch: (target: ChatFindRevealTarget) => void;
  private readonly reconcileMatch: (target: ChatFindReconcileTarget) => void;
  private readonly clearReveal: () => void;
  private readonly getMountedUnitRoot: (
    messageId: string,
    unitId: string,
  ) => HTMLElement | null;
  private readonly getMountedMessageRoot: (
    messageId: string,
  ) => HTMLElement | null;
  private readonly listeners = new Set<() => void>();
  private readonly highlighter: ChatFindHighlighter;

  private rows: ReadonlyArray<ChatFindRow> = [];
  private matches: ReadonlyArray<ChatFindMatch> = EMPTY_MATCHES;
  private activeMatchIndex = 0;
  private snapshot: TileFindStateSnapshot;
  private paintFrameId: number | null = null;
  private paintGeneration = 0;

  constructor(options: ChatFindAdapterOptions) {
    this.tileInstanceId = options.tileInstanceId;
    this.revealMatch = options.revealMatch;
    this.reconcileMatch = options.reconcileMatch;
    this.clearReveal = options.clearReveal;
    this.getMountedMessageRoot = options.getMountedMessageRoot;
    this.getMountedUnitRoot = options.getMountedUnitRoot;
    this.highlighter = new ChatFindHighlighter(options.tileInstanceId);
    this.snapshot = createChatFindSnapshot({
      requestId: 0,
      status: "idle",
      query: "",
      matchCase: false,
      current: 0,
      total: 0,
      activeUnitId: null,
      exactHighlight: "none",
    });
  }

  getSnapshot(): TileFindStateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  search(input: TileFindInput): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.highlighter.clear();
    this.matches =
      input.query.length === 0
        ? EMPTY_MATCHES
        : findMatches({
            rows: this.rows,
            query: input.query,
            matchCase: input.matchCase,
          });
    this.activeMatchIndex = 0;
    this.publishMatchState({
      requestId: input.requestId,
      query: input.query,
      matchCase: input.matchCase,
      navigate: true,
    });
  }

  next(): void {
    if (this.matches.length === 0 || this.snapshot.query.length === 0) return;
    this.activeMatchIndex = (this.activeMatchIndex + 1) % this.matches.length;
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: true,
    });
  }

  previous(): void {
    if (this.matches.length === 0 || this.snapshot.query.length === 0) return;
    this.activeMatchIndex =
      (this.activeMatchIndex - 1 + this.matches.length) % this.matches.length;
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: true,
    });
  }

  clear(): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.highlighter.clear();
    // Closing the bar must end scanning. updateRows runs from a layout effect on
    // every `messages` change (i.e. every streaming token) and is gated only on
    // `snapshot.query.length`, so leaving the query/matches set keeps re-running
    // findMatches over the whole transcript forever. Reset the scan state and
    // publish an idle, empty snapshot so a closed bar does no per-token work;
    // reopening re-runs search from scratch.
    this.matches = EMPTY_MATCHES;
    this.activeMatchIndex = 0;
    this.snapshot = createChatFindSnapshot({
      requestId: this.snapshot.requestId,
      status: "idle",
      query: "",
      matchCase: this.snapshot.matchCase,
      current: 0,
      total: 0,
      activeUnitId: null,
      exactHighlight: "none",
    });
    this.notify();
  }

  replaceCurrent(_input: TileReplaceInput): void {
    return undefined;
  }

  replaceAll(_input: TileReplaceInput): void {
    return undefined;
  }

  updateRows(rows: ReadonlyArray<ChatFindRow>): void {
    this.rows = rows;
    if (this.snapshot.query.length === 0) return;
    const previousActive = this.matches[this.activeMatchIndex] ?? null;
    this.matches = findMatches({
      rows,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
    });
    this.activeMatchIndex = nextActiveMatchIndex(
      this.matches,
      previousActive,
      this.activeMatchIndex,
    );
    this.publishMatchState({
      requestId: this.snapshot.requestId,
      query: this.snapshot.query,
      matchCase: this.snapshot.matchCase,
      navigate: false,
    });
  }

  syncMountedHighlight(): void {
    if (this.matches.length === 0 || this.snapshot.query.length === 0) return;
    this.requestHighlightPaint();
  }

  dispose(): void {
    this.clearReveal();
    this.cancelScheduledPaint();
    this.highlighter.dispose();
    this.listeners.clear();
  }

  private publishMatchState(args: {
    readonly requestId: number;
    readonly query: string;
    readonly matchCase: boolean;
    readonly navigate: boolean;
  }): void {
    if (args.query.length === 0) {
      this.matches = EMPTY_MATCHES;
      this.activeMatchIndex = 0;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "idle",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: 0,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.highlighter.clear();
      this.notify();
      return;
    }

    if (this.matches.length === 0) {
      this.activeMatchIndex = 0;
      this.clearReveal();
      this.snapshot = createChatFindSnapshot({
        requestId: args.requestId,
        status: "ready",
        query: args.query,
        matchCase: args.matchCase,
        current: 0,
        total: 0,
        activeUnitId: null,
        exactHighlight: "none",
      });
      this.highlighter.clear();
      this.notify();
      return;
    }

    const activeMatch = this.matches.at(this.activeMatchIndex);
    if (activeMatch === undefined) return;
    this.snapshot = createChatFindSnapshot({
      requestId: args.requestId,
      status: "ready",
      query: args.query,
      matchCase: args.matchCase,
      current: this.activeMatchIndex + 1,
      total: this.matches.length,
      activeUnitId: activeMatch.unitId,
      exactHighlight: "pending",
    });
    this.notify();
    if (args.navigate) {
      this.requestReveal(activeMatch);
      return;
    }
    this.requestReconcile(activeMatch);
    this.requestHighlightPaint();
  }

  private requestReveal(activeMatch: ChatFindMatch): void {
    const matchKey = chatFindMatchKey(activeMatch);
    const generation = this.paintGeneration + 1;
    this.paintGeneration = generation;
    this.revealMatch({
      messageId: activeMatch.messageId,
      unitId: activeMatch.unitId,
      owningChain: activeMatch.owningChain,
      matchKey,
      paint: () => this.paintMatch(generation, matchKey, "unit", true),
      paintFallback: () =>
        this.paintMatch(generation, matchKey, "message", true),
    });
  }

  private requestReconcile(activeMatch: ChatFindMatch): void {
    this.reconcileMatch({
      messageId: activeMatch.messageId,
      unitId: activeMatch.unitId,
      owningChain: activeMatch.owningChain,
      matchKey: chatFindMatchKey(activeMatch),
    });
  }

  private requestHighlightPaint(): void {
    this.cancelScheduledPaint();
    const activeMatch = this.matches.at(this.activeMatchIndex);
    if (activeMatch === undefined) return;
    const matchKey = chatFindMatchKey(activeMatch);
    const generation = this.paintGeneration + 1;
    this.paintGeneration = generation;
    this.paintFrameId = window.requestAnimationFrame(() => {
      this.paintFrameId = null;
      this.paintMatch(generation, matchKey, "unit", false);
    });
  }

  private paintMatch(
    generation: number,
    matchKey: string,
    scope: "unit" | "message",
    scrollActiveIntoView: boolean,
  ): void {
    if (this.paintGeneration !== generation) return;
    const requestId = this.snapshot.requestId;
    const query = this.snapshot.query;
    const matchCase = this.snapshot.matchCase;
    if (query.length === 0) return;
    const currentMatch = this.matches.at(this.activeMatchIndex);
    if (
      currentMatch === undefined ||
      chatFindMatchKey(currentMatch) !== matchKey
    ) {
      return;
    }
    const root =
      scope === "unit"
        ? this.getMountedUnitRoot(currentMatch.messageId, currentMatch.unitId)
        : this.getMountedMessageRoot(currentMatch.messageId);
    if (root === null) {
      if (this.getMountedMessageRoot(currentMatch.messageId) !== null) {
        this.highlighter.clear();
        if (this.snapshot.exactHighlight !== "pending") {
          this.snapshot = {
            ...this.snapshot,
            exactHighlight: "pending",
          };
          this.notify();
        }
      }
      return;
    }
    // The unit-scope root walks only the active unit, so the per-unit ordinal is
    // correct. The message-scope fallback root walks every unit in the message,
    // so it must use the message-wide ordinal - otherwise an earlier matching
    // unit steals the highlight.
    const activeOccurrence =
      scope === "message"
        ? currentMatch.occurrenceInMessage
        : currentMatch.occurrenceInUnit;
    const painted = this.highlighter.paint({
      root,
      query,
      matchCase,
      activeMatchIndex: activeOccurrence,
      scrollActiveIntoView,
    });
    if (this.snapshot.requestId !== requestId) return;
    if (!painted) {
      if (this.snapshot.exactHighlight !== "pending") {
        this.snapshot = {
          ...this.snapshot,
          exactHighlight: "pending",
        };
        this.notify();
      }
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      exactHighlight: "painted",
    };
    this.notify();
  }

  private cancelScheduledPaint(): void {
    this.paintGeneration += 1;
    if (this.paintFrameId === null) return;
    window.cancelAnimationFrame(this.paintFrameId);
    this.paintFrameId = null;
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

function createChatFindSnapshot(args: {
  readonly requestId: number;
  readonly status: TileFindStateSnapshot["status"];
  readonly query: string;
  readonly matchCase: boolean;
  readonly current: number;
  readonly total: number;
  readonly activeUnitId: string | null;
  readonly exactHighlight: TileFindStateSnapshot["exactHighlight"];
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: args.status,
    capabilities: CHAT_FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: "",
    current: args.current,
    total: args.total,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: args.activeUnitId,
    exactHighlight: args.exactHighlight,
  };
}

function findMatches(input: {
  readonly rows: ReadonlyArray<ChatFindRow>;
  readonly query: string;
  readonly matchCase: boolean;
}): ReadonlyArray<ChatFindMatch> {
  const needle = input.matchCase ? input.query : input.query.toLowerCase();
  const matches: ChatFindMatch[] = [];
  input.rows.forEach((row, rowIndex) => {
    let occurrenceInMessage = 0;
    row.units.forEach((unit, unitIndex) => {
      const haystack = input.matchCase ? unit.text : unit.text.toLowerCase();
      const step = Math.max(input.query.length, 1);
      let occurrenceInUnit = 0;
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        const end = index + input.query.length;
        matches.push({
          messageId: row.messageId,
          rowIndex,
          unitId: unit.unitId,
          unitIndex,
          start: index,
          end,
          occurrenceInUnit,
          occurrenceInMessage,
          // Context is sliced from the original-cased unit text so before/after
          // neighbours compare faithfully during reconciliation.
          contextBefore: unit.text.slice(
            Math.max(0, index - FIND_RECONCILE_CONTEXT_WINDOW),
            index,
          ),
          contextAfter: unit.text.slice(
            end,
            end + FIND_RECONCILE_CONTEXT_WINDOW,
          ),
          owningChain: unit.owningChain,
        });
        occurrenceInUnit += 1;
        occurrenceInMessage += 1;
        index = haystack.indexOf(needle, index + step);
      }
    });
  });
  return matches;
}

// Re-anchor the active match after a rescan. Streaming rebuilds the match set
// every keystroke/update, so the previously active occurrence must be tracked to
// the same logical spot without re-navigating. The catch: in a concatenated unit
// (subagent task+progress+result) a streamed insert that lands BEFORE the active
// occurrence shifts BOTH its per-unit ordinal (a query insert adds an earlier
// occurrence) AND its absolute offset, so neither alone is a stable identity.
// The occurrence's immediate neighbours are what stay put, so context wins before
// ordinal/offset fallbacks.
function nextActiveMatchIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch | null,
  fallbackIndex: number,
): number {
  if (matches.length === 0) return 0;
  if (previousActive !== null) {
    // The identical DOM occurrence (unit text unchanged, or only edited
    // elsewhere): same unit and same span. Unambiguous, so take it first.
    const identicalIndex = matches.findIndex(
      (match) =>
        match.messageId === previousActive.messageId &&
        match.unitId === previousActive.unitId &&
        match.start === previousActive.start &&
        match.end === previousActive.end,
    );
    if (identicalIndex !== -1) return identicalIndex;
    // The occurrence whose surrounding text best survives a mid-unit insert.
    const contextual = bestContextMatchIndexInSameUnit(matches, previousActive);
    if (contextual !== -1) return contextual;
    // Context was uninformative (e.g. the query spans the whole unit). Fall back
    // to the prior ordinal identity, then to the nearest offset.
    const sameOrdinal = matches.findIndex(
      (match) =>
        match.messageId === previousActive.messageId &&
        match.unitId === previousActive.unitId &&
        match.occurrenceInUnit === previousActive.occurrenceInUnit,
    );
    if (sameOrdinal !== -1) return sameOrdinal;
    const sameUnit = nearestMatchIndexInSameUnit(matches, previousActive);
    if (sameUnit !== -1) return sameUnit;
  }
  return Math.min(fallbackIndex, matches.length - 1);
}

// Among the candidates in the previously active unit, pick the one whose
// before/after neighbours best overlap the previous active occurrence's
// neighbours. The score is the shared run lengths (suffix of `contextBefore`
// plus prefix of `contextAfter`); an insert that lands on only one side leaves
// the other side fully intact, so the true occurrence still outscores a
// freshly-inserted duplicate. Ties resolve toward the prior ordinal, then the
// nearest offset, for determinism. Returns -1 when nothing overlaps.
function bestContextMatchIndexInSameUnit(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch,
): number {
  let bestIndex = -1;
  let bestScore = 0;
  let bestOrdinalDelta = 0;
  let bestStartDelta = 0;
  matches.forEach((match, index) => {
    if (match.messageId !== previousActive.messageId) return;
    if (match.unitId !== previousActive.unitId) return;
    const score =
      commonSuffixLength(match.contextBefore, previousActive.contextBefore) +
      commonPrefixLength(match.contextAfter, previousActive.contextAfter);
    if (score === 0) return;
    const ordinalDelta = Math.abs(
      match.occurrenceInUnit - previousActive.occurrenceInUnit,
    );
    const startDelta = Math.abs(match.start - previousActive.start);
    if (bestIndex === -1 || score > bestScore) {
      bestIndex = index;
      bestScore = score;
      bestOrdinalDelta = ordinalDelta;
      bestStartDelta = startDelta;
      return;
    }
    if (score < bestScore) return;
    if (
      ordinalDelta < bestOrdinalDelta ||
      (ordinalDelta === bestOrdinalDelta && startDelta < bestStartDelta)
    ) {
      bestIndex = index;
      bestOrdinalDelta = ordinalDelta;
      bestStartDelta = startDelta;
    }
  });
  return bestIndex;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (
    length < limit &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function chatFindMatchKey(match: ChatFindMatch): string {
  return `${match.messageId}:${match.unitId}:${match.occurrenceInUnit}`;
}

function nearestMatchIndexInSameUnit(
  matches: ReadonlyArray<ChatFindMatch>,
  previousActive: ChatFindMatch,
): number {
  return matches.reduce((bestIndex, match, index) => {
    if (match.messageId !== previousActive.messageId) return bestIndex;
    if (match.unitId !== previousActive.unitId) return bestIndex;
    if (bestIndex === -1) return index;
    const best = matches.at(bestIndex);
    if (best === undefined) return index;
    const bestDistance = Math.abs(best.start - previousActive.start);
    const candidateDistance = Math.abs(match.start - previousActive.start);
    return candidateDistance < bestDistance ? index : bestIndex;
  }, -1);
}

class ChatFindHighlighter {
  private readonly names: HighlightNames;
  private styleElement: HTMLStyleElement | null = null;

  constructor(tileInstanceId: string) {
    const suffix = stableCssIdentSuffix(tileInstanceId);
    this.names = {
      match: `traycer-chat-find-match-${suffix}`,
      active: `traycer-chat-find-active-${suffix}`,
    };
  }

  paint(input: {
    readonly root: HTMLElement;
    readonly query: string;
    readonly matchCase: boolean;
    readonly activeMatchIndex: number;
    readonly scrollActiveIntoView: boolean;
  }): boolean {
    const highlights = getHighlights();
    if (highlights === null || typeof Highlight === "undefined") return false;
    const ranges = collectTextRanges(input);
    if (ranges.length === 0) {
      this.clear();
      return false;
    }
    const active = ranges.at(input.activeMatchIndex);
    if (active === undefined) {
      this.clear();
      return false;
    }
    this.ensureStyleElement();
    const others = ranges.filter(
      (_range, index) => index !== input.activeMatchIndex,
    );
    if (others.length > 0) {
      highlights.set(this.names.match, new Highlight(...others));
    } else {
      highlights.delete(this.names.match);
    }
    highlights.set(this.names.active, new Highlight(active));
    // The active match may sit below the fold of a card's own height-capped
    // scroll container (subagent/A2A bodies use `max-h` + `overflow-auto`).
    // Scrolling the match's element walks every scroll ancestor, so the inner
    // container reveals the match in addition to the chat row scroll the reveal
    // controller already did. Only the navigation paint passes this; passive
    // streaming/sync repaints must never yank the scroll position.
    if (input.scrollActiveIntoView) {
      active.startContainer.parentElement?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
    return true;
  }

  clear(): void {
    const highlights = getHighlights();
    if (highlights === null) return;
    highlights.delete(this.names.match);
    highlights.delete(this.names.active);
  }

  dispose(): void {
    this.clear();
    this.styleElement?.remove();
    this.styleElement = null;
  }

  private ensureStyleElement(): void {
    if (this.styleElement !== null) return;
    const style = document.createElement("style");
    style.dataset.traycerChatFindHighlight = this.names.match;
    style.textContent = [
      `::highlight(${this.names.match}) {`,
      "background-color: color-mix(in srgb, var(--primary) 35%, transparent);",
      "color: inherit;",
      "}",
      `::highlight(${this.names.active}) {`,
      "background-color: color-mix(in srgb, var(--primary) 75%, transparent);",
      "color: var(--primary-foreground);",
      "}",
    ].join("\n");
    document.head.append(style);
    this.styleElement = style;
  }
}

function getHighlights(): SupportedHighlightsAPI | null {
  if (typeof CSS === "undefined") return null;
  const registry = (CSS as { highlights?: SupportedHighlightsAPI }).highlights;
  return registry ?? null;
}

function collectTextRanges(input: {
  readonly root: HTMLElement;
  readonly query: string;
  readonly matchCase: boolean;
  readonly activeMatchIndex: number;
}): ReadonlyArray<Range> {
  const needle = input.matchCase ? input.query : input.query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(input.root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (parent === null) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIPPED_HIGHLIGHT_ANCESTOR_SELECTOR) !== null) {
        return NodeFilter.FILTER_REJECT;
      }
      const button = parent.closest("button");
      if (
        button !== null &&
        button.closest(INCLUDED_BUTTON_HIGHLIGHT_SELECTOR) === null
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    const haystack = input.matchCase ? node.data : node.data.toLowerCase();
    const step = Math.max(input.query.length, 1);
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      const range = new Range();
      range.setStart(node, index);
      range.setEnd(node, index + input.query.length);
      ranges.push(range);
      index = haystack.indexOf(needle, index + step);
    }
    node = walker.nextNode() as Text | null;
  }
  return ranges;
}

function stableCssIdentSuffix(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
