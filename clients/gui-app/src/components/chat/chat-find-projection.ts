import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import {
  buildChatActivityTimeline,
  hidesSoleReasoningHeader,
  reasoningBlockLabel,
} from "@/components/chat/chat-activity-groups";
import {
  deriveA2AReceivedCollapsibleKey,
  deriveA2ASendCollapsibleKey,
  deriveActivityGroupCollapsibleKey,
  deriveInterviewCollapsibleKey,
  derivePromotedSubagentRenderId,
  deriveSubagentCollapsibleKey,
  type ChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import { deriveInterviewReviewModel } from "@/components/chat/segments/interview-review-model";
import {
  adjacentDedupedProgressItems,
  cleanSubagentNotificationText,
} from "@/components/chat/segments/subagent-display";
import { singleSpecialSegment } from "@/components/chat/chat-special-segment";
import { parseTraycerNextStepsMarkdown } from "@/markdown/traycer-next-steps";
import { composerDisplayPlainText } from "@/lib/composer/composer-clipboard";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";
import { segmentStepLabel } from "@/lib/chat/todo-status-tones";
import {
  PLAN_PREVIEW_STEP_LIMIT,
  planCardSubtitle,
  planFallbackMarkdown,
  planHeadline,
  planStatusBadgeLabel,
} from "@/components/chat/segments/plan-display";
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
  /**
   * The renderer's live promotion set, threaded in verbatim. Find must group
   * runs exactly as the renderer does: a unit id and owning chain are both
   * derived from the group a segment lands in, so a projection that grouped
   * differently would emit ids no element carries and chains that open the
   * wrong disclosure - matches counted but impossible to paint or navigate to.
   */
  promotedToolBlockIds: ReadonlySet<string>,
): ReadonlyArray<ChatFindRow> {
  return messages.map((message) => {
    const units = chatFindUnitsForMessage(
      message,
      tileInstanceId,
      promotedToolBlockIds,
    );
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
  promotedToolBlockIds: ReadonlySet<string>,
): ReadonlyArray<ChatFindUnit> {
  if (message.role === "assistant") {
    const turnState = message.runState === null ? "complete" : "active";
    return buildChatActivityTimeline(message.segments, {
      turnState,
      promotedToolBlockIds,
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

  // A synthesized row whose single segment is a setup-card / forked-chat-link
  // renders that segment's own find anchor and no content block (the render side
  // is renderSingleSpecialSegment in chat-message.tsx; both key off the shared
  // singleSpecialSegment predicate), so index the segment.
  const specialSegment = singleSpecialSegment(message.segments);
  if (specialSegment !== null) {
    return segmentSearchUnits(specialSegment, tileInstanceId);
  }

  // Every other user/system message renders its whole body as ONE anchor
  // (message:{id}:content) via UserMessageBody - never per-segment anchors. Its
  // `text` segments mirror that content, so also projecting them would
  // double-count every match with a phantom unit that has no anchor to paint.
  // Project the content unit alone so the count matches what actually renders.
  // The DISPLAY projection, not the clipboard one: find has to index the text
  // the DOM actually paints, or a `$`-written chip is unfindable by what it
  // reads as and findable by a `/name` the highlighter cannot locate.
  const contentText =
    message.structuredContent === null
      ? message.content
      : composerDisplayPlainText(message.structuredContent);
  return compactUnits([
    chatFindUnit({
      unitId: chatFindMessageContentUnitId(message.id),
      text: contentText,
      owningChain: [],
    }),
  ]);
}

function timelineItemSearchUnits(
  item: ChatActivityTimelineItem,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  if (item.kind === "segment") {
    return segmentSearchUnits(item.segment, tileInstanceId);
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
  // Hoisted: a group property, not a per-child one, and computing it inside the
  // flatMap would walk the segment list once per segment.
  const headerlessReasoning = hidesSoleReasoningHeader(group.segments);
  return compactUnits([
    chatFindUnit({
      unitId: chatFindActivityGroupSummaryUnitId(group.id),
      text: group.label,
      owningChain: [],
    }),
    // A reveal force-opens the group, and every child that renders a header
    // renders it in both the live window and the expanded body, so each of
    // these units has somewhere to paint. The ONE child that renders no header
    // is a group's sole reasoning block, and it is skipped below - its label is
    // already the group summary's own leading clause, so nothing leaves the
    // index with it.
    ...group.segments.flatMap((segment) =>
      activityGroupChildSearchUnits({
        segment,
        groupId: group.id,
        groupChain: [groupKey],
        tileInstanceId,
        headerlessReasoning,
      }),
    ),
  ]);
}

interface ActivityGroupChildSearchUnitsArgs {
  readonly segment: ActivityGroupModel["segments"][number];
  readonly groupId: string;
  readonly groupChain: ReadonlyArray<ChatCollapsibleKey>;
  readonly tileInstanceId: string;
  /** The group's sole reasoning block renders unheaded, so it has no anchor. */
  readonly headerlessReasoning: boolean;
}

function activityGroupChildSearchUnits(
  args: ActivityGroupChildSearchUnitsArgs,
): ReadonlyArray<ChatFindUnit> {
  const { segment, groupId, groupChain, tileInstanceId } = args;
  if (segment.kind === "reasoning" && args.headerlessReasoning) return [];
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
  if (segment.kind === "interview") {
    return interviewSearchUnits(segment, tileInstanceId);
  }
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

function interviewSearchUnits(
  segment: InterviewSegment,
  tileInstanceId: string,
): ReadonlyArray<ChatFindUnit> {
  if (segment.status === "streaming") return [];
  const model = deriveInterviewReviewModel({
    blockId: segment.id,
    status: segment.status,
    toolName: segment.toolName,
    title: segment.title,
    description: segment.description,
    questions: segment.questions,
    answers: segment.answers,
    draftAnswers: segment.draftAnswers,
    outcome: segment.outcome,
    settlement: segment.settlement,
    error: segment.error,
    delivery: segment.delivery,
    forkedWithoutAnswer: segment.forkedWithoutAnswer,
  });
  // Historical interview details live behind the card disclosure. Every field
  // therefore owns the same force-open chain as the rendered card, including
  // the summary (which remains mounted both before and after expansion).
  const owningChain = [
    deriveInterviewCollapsibleKey(tileInstanceId, segment.id),
  ];
  return model.searchableFields.map((field) => ({
    unitId: field.unitId,
    text: field.text,
    owningChain,
  }));
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
    case "provider_notice":
      return providerNoticeSegmentSearchText(segment);
    case "interview":
      return [];
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
    case "reasoning":
      return reasoningSegmentSearchText(segment);
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

function providerNoticeSegmentSearchText(
  segment: Extract<MessageSegment, { kind: "provider_notice" }>,
): ReadonlyArray<string> {
  return [
    normalizeSearchableText(
      [
        segment.title,
        segment.message ?? "",
        ...segment.details.flatMap((detail) => [detail.label, detail.value]),
      ].join(" "),
    ),
  ];
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
    segment.children.flatMap((child) => {
      if (child.kind === "subagent") {
        return subagentSegmentSearchUnits({
          segment: child,
          renderId: child.id,
          parentChain: bodyChain,
          ownKey: deriveSubagentCollapsibleKey(tileInstanceId, child.id),
          tileInstanceId,
        });
      }
      // A nested provider notice renders as a visible row inside this
      // subagent's own body (see `SubagentChildProviderNotices`), so its
      // owning chain opens the SAME body key as the subagent's other content
      // - not a further-nested key of its own.
      if (child.kind === "provider_notice") {
        return compactUnits([
          chatFindUnit({
            unitId: chatFindSegmentUnitId(child.id),
            text: segmentSearchText(child).join("\n"),
            owningChain: bodyChain,
          }),
        ]);
      }
      return [];
    }),
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
  return [reasoningBlockLabel(segment.isStreaming, segment.durationMs)];
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
