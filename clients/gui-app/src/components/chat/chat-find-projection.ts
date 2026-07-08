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
  ApprovalSegment,
  SubagentSegment,
  ToolSegment,
} from "@/stores/composer/chat-store";

export interface ChatFindRow {
  readonly messageId: string;
  readonly units: ReadonlyArray<ChatFindUnit>;
}

export interface ChatFindUnit {
  readonly unitId: string;
  readonly text: string;
  readonly owningChain: ReadonlyArray<ChatCollapsibleKey>;
}

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
const CHAT_FIND_PREVIEW_MAX_LENGTH = 180;

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
    return subagentSegmentSearchUnits({
      segment: item.segment,
      renderId,
      parentChain: [],
      ownKey: deriveSubagentCollapsibleKey(tileInstanceId, renderId),
      tileInstanceId,
    });
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
    return subagentSegmentSearchUnits({
      segment,
      renderId,
      parentChain: groupChain,
      ownKey: deriveSubagentCollapsibleKey(tileInstanceId, renderId),
      tileInstanceId,
    });
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
    return subagentSegmentSearchUnits({
      segment,
      renderId,
      parentChain: [],
      ownKey: deriveSubagentCollapsibleKey(tileInstanceId, renderId),
      tileInstanceId,
    });
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
      return approvalHeaderSearchText(segment);
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
      return approvalHeaderSearchText(segment);
    case "subagent":
      return [];
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return [];
    }
  }
}

function approvalHeaderSearchText(
  segment: ApprovalSegment,
): ReadonlyArray<string> {
  // Mirror the rendered header label: verdict + (toolName ?? description ??
  // "approval"). Body text is unanchored, so indexing it would count matches
  // that cannot paint.
  return [
    segment.decision?.approved === true ? "Approved" : "Denied",
    segment.toolName ?? segment.description ?? "approval",
  ];
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
//   - body (task + progress + result, or for a workflow card: intent +
//     activity + result): inside the subagent's own collapsible, so its chain
//     additionally includes the subagent's own key.
// PLUS one recursive pass per nested agent child (the "Sub-agents" section) -
// each renders as its own `row` inside THIS subagent's body, so its search
// units chain through this subagent's body key exactly as deep as a user must
// expand to reach it.
interface SubagentSegmentSearchUnitsArgs {
  readonly segment: SubagentSegment;
  readonly renderId: string;
  readonly parentChain: ReadonlyArray<ChatCollapsibleKey>;
  readonly ownKey: ChatCollapsibleKey;
  readonly tileInstanceId: string;
}

function subagentSegmentSearchUnits(
  args: SubagentSegmentSearchUnitsArgs,
): ReadonlyArray<ChatFindUnit> {
  const { ownKey, parentChain, renderId, segment, tileInstanceId } = args;
  const bodyChain = [...parentChain, ownKey];
  return compactUnits([
    chatFindUnit({
      unitId: chatFindSubagentHeaderUnitId(renderId),
      text: subagentHeaderSearchText(segment),
      owningChain: parentChain,
    }),
    chatFindUnit({
      unitId: chatFindSubagentBodyUnitId(renderId),
      text: subagentBodySearchText(segment).join("\n"),
      owningChain: bodyChain,
    }),
  ]).concat(
    segment.children.flatMap((child) =>
      child.kind === "subagent"
        ? subagentSegmentSearchUnits({
            segment: child,
            renderId: child.id,
            parentChain: bodyChain,
            ownKey: deriveSubagentCollapsibleKey(tileInstanceId, child.id),
            tileInstanceId,
          })
        : [],
    ),
  );
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
  const workflowMeta = segment.workflowMeta;
  const resultText =
    segment.result === null ? "" : markdownToChatSearchText(segment.result);
  // The workflow card replaces Task/Progress with Intent/Activity, so index
  // only what it actually renders - the base task/progressUpdates fields are
  // the dual-written degradation for old readers, never shown here.
  if (workflowMeta !== null) {
    return [
      workflowMeta.intent ?? "",
      ...workflowMeta.activity.map((entry) => entry.text),
      resultText,
    ];
  }
  return [
    cleanSubagentNotificationText(segment.task) ?? "",
    // Progress is rendered raw and adjacent-deduped; index the SAME deduped raw
    // lines so the counter matches the rendered list (no phantom duplicates).
    ...adjacentDedupedProgressItems(segment.progressUpdates).map(
      (item) => item.text,
    ),
    resultText,
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
