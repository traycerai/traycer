import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import { useRegionShown } from "@/lib/layout-overrides";
import { useRegionGhost } from "@/components/layout-editor/use-layout-region";
import { BrowserSessionRow } from "./segments/browser-session-row";
import { chatFindSegmentUnitId } from "@/components/chat/chat-find";
import { ChatBlockNavigationAnchor } from "@/components/chat/chat-navigation-highlight";
import { useTranscriptQueuePauseReasonSupport } from "@/components/chat/use-transcript-queue-pause-reason-support";
import { segmentsShownInTranscript } from "@/stores/chats/hidden-transcript-notices";
import {
  WorkingVerbContext,
  pickWorkingVerb,
} from "@/components/chat/working-verb";
import { isFastModeEnabled } from "@/components/home/data/landing-options";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  AssistantTurnMeta,
  ChatMessageRunState,
  ChatMessageStoppedInfo,
  FoldedBackgroundEvent,
  MessageSegment,
} from "@/stores/composer/chat-store";
import { backgroundEventEnding } from "@/stores/chats/background-event-fold";
import { Check, Copy, Sparkles, Split, Square, Volume2 } from "lucide-react";
import { use, useCallback, useMemo, useRef } from "react";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useReadAloud } from "@/hooks/ui/use-read-aloud";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import {
  collectAssistantReplyMarkdowns,
  collectAssistantReplyText,
} from "@/lib/chat/collect-assistant-reply-text";
import {
  useEpicAgentRoleClaimsByAgentId,
  useEpicArtifactRecords,
} from "@/lib/epic-selectors";
import { spokenParagraphsFromRenderedReply } from "@/lib/speech/spoken-reply-dom";
import {
  spokenParagraphsFromReplyMarkdown,
  type AgentLabelResolver,
} from "@/markdown/spoken-paragraphs";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { resolveAgentReference } from "./agent-reference-resolution";
import { knownHarnessId } from "@/lib/chat/sender-display";
import { formatClockDuration, formatWorkedFor } from "@/lib/format-duration";
import {
  formatMessageTimeWithSeconds,
  useSampledNow,
} from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { ChatMessageForkAction } from "./chat-message";
import type { InterviewDeliveryRetryAction } from "./segments/interview-delivery-retry-action";
import { ActivityGroupSegment } from "./segments/activity-group-segment";
import { ResolvedApprovalSegment } from "./segments/approval-segment";
import { ArtifactCardSegment } from "./segments/artifact-card-segment";
import { CommandSegment } from "./segments/command-segment";
import { CompactionSegment } from "./segments/compaction-segment";
import {
  AutonomousResumeSegment,
  type BackgroundEventCardEnding,
} from "./segments/autonomous-resume-segment";
import { ErrorSegment } from "./segments/error-segment";
import type { RoutingSettledNotice } from "@/components/chat/fallback/routing-settled-card";
import { FileChangeGroupSegment } from "./segments/file-change-group-segment";
import { FileChangeSegment } from "./segments/file-change-segment";
import { InterviewSegment } from "./segments/interview-segment";
import type { NextStepActionHandler } from "./segments/next-steps-action-group";
import { PlanSegment } from "./segments/plan-segment";
import { ProviderNoticeSegment } from "./segments/provider-notice-segment";
import { ReasoningSegment } from "./segments/reasoning-segment";
import { SubagentSegment } from "./segments/subagent-segment";
import { TextSegment } from "./segments/text-segment";
import { TodoSegment } from "./segments/todo-segment";
import { ToolSegment } from "./segments/tool-segment";
import { distinctRenderKeys } from "./segment-render-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

const COPIED_RESET_MS = 1600;

const handleCopyError = (): void => {
  reportableErrorToast("Couldn't copy to clipboard.", undefined, {
    title: "Could not copy to clipboard",
    message: null,
    code: null,
    source: "Clipboard",
  });
};

interface AssistantBodyProps {
  workingVerbSeed?: string;
  segments: ReadonlyArray<MessageSegment>;
  backgroundToolBlockIds: ReadonlySet<string>;
  /**
   * Host-owned run state of this turn. Non-null only for the active turn;
   * drives the in-progress indicator that persists for the whole turn (first
   * message and every multi-turn send) and flips to "Stopping…" on stop.
   */
  runState: ChatMessageRunState | null;
  /**
   * Stable per-turn id (e.g. `assistant:<turnKey>`). Seeds the elapsed
   * footer's verb so each turn gets its own verb even when sibling turns
   * share `createdAt` (e.g. multiple turns following one user-send).
   */
  messageId: string;
  /** Wall-clock turn start used only for elapsed-duration calculations. */
  elapsedStartedAt: number;
  /** Whether the complete turn contains only autonomous-resume dividers. */
  turnHasOnlyAutonomousResumeSegments: boolean;
  /** See `ChatMessage.autonomousResumeOwed`. */
  autonomousResumeOwed: boolean;
  /** See `ChatMessage.foldedBackgroundEvents`; absent when nothing folded. */
  foldedBackgroundEvents: ReadonlyArray<FoldedBackgroundEvent> | undefined;
  /** Whether this terminal row should render its elapsed completion footer. */
  showCompletionFooter: boolean;
  /** User-wait time already accumulated during this assistant turn. */
  pausedDurationMs: number;
  /** Start of an open user-wait interval for this turn, if any. */
  pausedSinceMs: number | null;
  /**
   * Wall-clock turn end; non-null once the turn finishes. Drives the elapsed
   * footer.
   */
  completedAt: number | null;
  /**
   * Present when this turn ended via a user Stop (direct or cascaded
   * `agent.stop`), derived from the persisted `turn.stopped` chat event.
   * Drives the "Stopped · Nm Xs" footer variant, the "Stopped before
   * responding" empty-turn note, and the error-suppression override on
   * `shouldShowElapsedFooter`.
   */
  stopped: ChatMessageStoppedInfo | null;
  /**
   * Per-turn agent run metadata (provider, model, reasoning effort, fast mode)
   * surfaced through the elapsed footer's info tooltip. `null` for turns that
   * predate the persisted run-metadata fields.
   */
  meta: AssistantTurnMeta | null;
  /**
   * The host turn this row is. Null on user rows, synthesized event rows, and
   * records persisted before `turnId` existed - all of which correctly match
   * no host-named attempt and therefore offer no manual rungs.
   */
  turnId: string | null;
  /**
   * The error segment on THIS row that carries the manual recovery actions, or
   * `null` when the row carries none - resolved once per turn at projection
   * time (see `manualRungAnchorSegmentId`) and read here rather than
   * recomputed.
   *
   * It is not derivable from this component's own inputs, which is why it is a
   * prop: a steered turn splits into several rows that share one `turnId`, and
   * this row sees only its own slice. A walk over that slice answers "which
   * block of this FRAGMENT describes the failure", and on a turn whose failure
   * straddles a steer both fragments answer confidently - two recovery groups
   * for one failed attempt.
   */
  manualRungAnchorId: string | null;
  /**
   * The settled routing notice the anchor's card absorbs, or `null` - see
   * `ChatMessage.routingSettledNoticeId`. The notice then renders nothing of
   * its own and the anchor error renders the settled card.
   */
  routingSettledNoticeId: string | null;
  nextStepActions: NextStepActionHandler | null;
  forkAction: ChatMessageForkAction | null;
  interviewDeliveryRetry: InterviewDeliveryRetryAction | null;
}

type ProviderNoticeMessageSegment = Extract<
  MessageSegment,
  { kind: "provider_notice" }
>;

/**
 * The settled notice on this row, as the card reads it - or `null` when the
 * row absorbs none, or when the id names no receipt-carrying notice here
 * (which the projection rules out, and which then leaves the divider and the
 * plain card exactly as an older host's transcript has them).
 *
 * Only beside an anchor on this row: the settled card IS the anchor's card,
 * and a notice with no card to fold into stays a divider.
 */
function settledNoticeOnRow(
  segments: ReadonlyArray<MessageSegment>,
  routingSettledNoticeId: string | null,
  manualRungAnchorId: string | null,
): { readonly id: string; readonly notice: RoutingSettledNotice } | null {
  if (routingSettledNoticeId === null || manualRungAnchorId === null) {
    return null;
  }
  const segment = segments.find(
    (candidate): candidate is ProviderNoticeMessageSegment =>
      candidate.kind === "provider_notice" &&
      candidate.id === routingSettledNoticeId,
  );
  if (segment === undefined || segment.receipt === null) return null;
  return {
    id: segment.id,
    notice: {
      title: segment.title,
      message: segment.message,
      details: segment.details,
      receipt: segment.receipt,
    },
  };
}

/** The recovery props one timeline item renders with. */
interface RecoveryProps {
  readonly turnId: string | null;
  readonly settledNotice: RoutingSettledNotice | null;
  readonly settledNoticeFindUnitId: string | null;
}

const NO_RECOVERY: RecoveryProps = {
  turnId: null,
  settledNotice: null,
  settledNoticeFindUnitId: null,
};

/**
 * What one item of this row is to the turn's recovery: the anchor (it gets the
 * turn id, and the settled notice when the row has one), the absorbed settled
 * notice (it renders nothing - the anchor's card paints it), or neither.
 */
function recoveryRoleOf(
  itemId: string,
  input: {
    readonly manualRungAnchorId: string | null;
    readonly turnId: string | null;
    readonly settled: {
      readonly id: string;
      readonly notice: RoutingSettledNotice;
    } | null;
  },
): RecoveryProps | "absorbed" {
  const { manualRungAnchorId, turnId, settled } = input;
  if (settled !== null && itemId === settled.id) return "absorbed";
  if (manualRungAnchorId === null || itemId !== manualRungAnchorId) {
    return NO_RECOVERY;
  }
  return {
    turnId,
    settledNotice: settled === null ? null : settled.notice,
    settledNoticeFindUnitId:
      settled === null ? null : chatFindSegmentUnitId(settled.id),
  };
}

export function AssistantMessageBody({
  segments,
  backgroundToolBlockIds,
  runState,
  messageId,
  workingVerbSeed,
  elapsedStartedAt,
  turnHasOnlyAutonomousResumeSegments,
  autonomousResumeOwed,
  foldedBackgroundEvents,
  showCompletionFooter,
  pausedDurationMs,
  pausedSinceMs,
  completedAt,
  stopped,
  meta,
  turnId,
  manualRungAnchorId,
  routingSettledNoticeId,
  nextStepActions,
  forkAction,
  interviewDeliveryRetry,
}: AssistantBodyProps) {
  const activityTimelineTurnState = runState === null ? "complete" : "active";
  // A ghost while the editor points at hidden Thinking (L-14).
  const thinkingShown = useRegionShown("thinking");
  const thinkingGhost = useRegionGhost("thinking");
  const queuePauseReasonSupport = useTranscriptQueuePauseReasonSupport();
  // What this row draws: the host's notices this client keeps off screen are
  // gone before anything is built from the list (`hidden-transcript-notices`).
  const shownSegments = useMemo(
    () => segmentsShownInTranscript(segments, queuePauseReasonSupport),
    [queuePauseReasonSupport, segments],
  );
  const settled = useMemo(
    () =>
      settledNoticeOnRow(segments, routingSettledNoticeId, manualRungAnchorId),
    [manualRungAnchorId, routingSettledNoticeId, segments],
  );
  const timeline = useMemo(
    () =>
      buildChatActivityTimeline(shownSegments, {
        turnState: activityTimelineTurnState,
        promotedToolBlockIds: backgroundToolBlockIds,
        hideReasoning: !(thinkingShown || thinkingGhost),
      }),
    [
      activityTimelineTurnState,
      backgroundToolBlockIds,
      shownSegments,
      thinkingGhost,
      thinkingShown,
    ],
  );
  const timelineKeys = useMemo(
    () =>
      distinctRenderKeys(
        timeline.map((item) => ({
          id: item.id,
          kind: item.kind === "segment" ? item.segment.kind : item.kind,
        })),
      ),
    [timeline],
  );
  // A content-less boundary row's own segments never carry copyable text
  // (the reply lives on an earlier row in the same turn, before the trailing
  // steer bubble) - fall back to the turn-wide text `withTurnCompletion`
  // aggregated onto `stopped` so the copy button still has something to
  // copy. Every other row (including a stopped row that legitimately has its
  // own content) keeps using its own segments, unchanged.
  const boundaryReplySegments = boundaryReplySegmentsOf(segments, stopped);
  const replyText = useMemo(
    () => collectAssistantReplyText(boundaryReplySegments ?? segments),
    [boundaryReplySegments, segments],
  );
  // A completed turn that is nothing but a background event drew no reply,
  // and its card says how it ended - so the row draws no footer of its own.
  const silentAutonomousResume =
    stopped === null && turnHasOnlyAutonomousResumeSegments;
  const backgroundCard = backgroundCardContent({
    silentAutonomousResume,
    showCompletionFooter,
    autonomousResumeOwed,
    runState,
    completedAt,
    elapsedStartedAt,
    pausedDurationMs,
    meta,
    foldedBackgroundEvents,
  });
  const backgroundCardSegmentId = headBackgroundEventSegmentId(shownSegments);
  const stoppedBeforeResponding = stopped !== null && !stopped.turnHadOutput;
  const showElapsedFooter =
    !stoppedBeforeResponding &&
    !silentAutonomousResume &&
    showCompletionFooter &&
    shouldShowElapsedFooter(
      runState,
      completedAt,
      lastSegmentDrawnOnItsOwn(
        shownSegments,
        settled === null ? null : settled.id,
      ),
      stopped,
    );
  // No content yet. While the turn is live (`runState` non-null) show the
  // in-progress indicator for the pre-first-token gap. Once the turn has
  // ended (`runState === null`), a genuinely empty stopped turn (no output
  // anywhere) gets its own note - the transcript must always explain why
  // there is no reply. A content-less STOPPED row whose turn DID produce
  // output elsewhere (`stopped.turnHadOutput`) - the boundary marker
  // synthesized after a trailing steer bubble - falls through to the normal
  // render below instead: an empty `segments` there renders an empty
  // timeline plus just the elapsed footer, which is exactly the "Stopped ·
  // Nm Xs" the turn's true end needs. Any other ended, empty turn renders
  // nothing, NEVER a "Working…" indicator that would stick. A row holding
  // only hidden notices is empty here too.
  if (shownSegments.length === 0) {
    if (runState !== null) {
      return (
        <AssistantRunIndicator
          runState={runState}
          createdAt={elapsedStartedAt}
          pausedDurationMs={pausedDurationMs}
          pausedSinceMs={pausedSinceMs}
          messageId={indicatorMessageId({ workingVerbSeed, messageId })}
          meta={meta}
        />
      );
    }
    if (stopped === null || !stopped.turnHadOutput) {
      return stopped === null ? null : <StoppedBeforeResponding />;
    }
  }
  return (
    <div
      className="flex w-full max-w-none flex-col gap-2 py-1 @container"
      data-assistant-turn
    >
      {timeline.map((item, index) => {
        const key = timelineKeys[index];
        if (item.kind === "activity_group") {
          return <ActivityGroupSegment key={key} group={item.group} />;
        }
        if (item.kind === "promoted_subagent") {
          return (
            <ChatBlockNavigationAnchor key={key} blockId={item.segment.id}>
              <SubagentSegment
                id={item.id}
                cardId={item.segment.id}
                toolImageResults={item.segment.toolImageResults}
                name={item.segment.name}
                agentType={item.segment.agentType}
                task={item.segment.task}
                progressUpdates={item.segment.progressUpdates}
                result={item.segment.result}
                isStreaming={item.segment.isStreaming}
                endState={item.segment.endState}
                stopped={item.segment.stopped}
                startedAt={item.segment.startedAt}
                durationMs={item.segment.durationMs}
                workflowMeta={item.segment.workflowMeta}
                nested={item.segment.children}
                variant="promoted"
              />
            </ChatBlockNavigationAnchor>
          );
        }
        const recovery = recoveryRoleOf(item.id, {
          manualRungAnchorId,
          turnId,
          settled,
        });
        // The settled notice is painted inside the anchor's settled card.
        if (recovery === "absorbed") return null;
        return (
          <ChatBlockNavigationAnchor key={key} blockId={item.id}>
            <AssistantSegment
              id={item.id}
              segment={item.segment}
              backgroundToolBlockIds={backgroundToolBlockIds}
              nextStepActions={nextStepActions}
              forkAction={forkAction}
              interviewDeliveryRetry={interviewDeliveryRetry}
              // The turn's OWN harness, for an error row that offers to open that
              // provider's settings. Taken from the row rather than from ambient
              // app state so the link points at the provider that actually failed,
              // even when the transcript is scrolled back to a turn from a harness
              // the chat has since switched away from. `null` on legacy turns with
              // no metadata; the affordance then falls back to the section root.
              harnessId={meta === null ? null : knownHarnessId(meta.provider)}
              // ONE segment, not every error row on the turn, and not one per
              // row of a split turn. A failed turn routinely carries several
              // error blocks that all share this `turnId` - the queue-pause
              // notice the host appends beside the failure, a non-terminal
              // extension error before the real terminal - and handing the id to
              // each of them rendered a full recovery group under each,
              // including under "Resume the queue to send them", where Retry
              // retried the failed prompt instead.
              //
              // The anchor names the segment that describes the failed ATTEMPT.
              // It is resolved over the WHOLE turn, but not before the split -
              // `planAssistantTurnRows` splits first and the rows are built, then
              // `withManualRungAnchor` runs LAST and rebuilds the ordered
              // whole-turn segment list from those finished rows
              // (`assistantTurnSegments`). Whole-turn is a claim about the INPUT
              // to the walk, not about its position in the pipeline. Either way a
              // turn rendered as several rows still names exactly one. On every
              // other row `manualRungAnchorId` is null and nothing here matches
              // - the same answer a row with no turn identity already gets.
              turnId={recovery.turnId}
              settledNotice={recovery.settledNotice}
              settledNoticeFindUnitId={recovery.settledNoticeFindUnitId}
              backgroundCard={
                item.id === backgroundCardSegmentId ? backgroundCard : null
              }
            />
          </ChatBlockNavigationAnchor>
        );
      })}
      {/* Trailing indicator keeps the in-progress cue visible for the whole
          turn once content has started streaming, not just the empty gap. */}
      {runState !== null ? (
        <AssistantRunIndicator
          runState={runState}
          createdAt={elapsedStartedAt}
          pausedDurationMs={pausedDurationMs}
          pausedSinceMs={pausedSinceMs}
          messageId={indicatorMessageId({ workingVerbSeed, messageId })}
          meta={meta}
        />
      ) : null}
      {stoppedBeforeResponding ? <StoppedBeforeResponding /> : null}
      {showElapsedFooter ? (
        <AssistantElapsedFooter
          messageId={messageId}
          createdAt={elapsedStartedAt}
          pausedDurationMs={pausedDurationMs}
          completedAt={completedAt}
          stopped={stopped}
          meta={meta}
          replyText={replyText}
          boundaryReplySegments={boundaryReplySegments}
          forkAction={forkAction}
        />
      ) : null}
    </div>
  );
}

/**
 * The footer represents successful "worked for" framing. Suppress for live
 * turns (still working), turns with no completion timestamp, and turns whose
 * last block is an error (the host emits a terminal `error` block when the
 * turn fails - rendering "Cogitated for ..." in that case misrepresents an
 * error as a successful run). A user Stop overrides the error suppression: a
 * turn.stopped event means the turn ended because the user asked it to, not
 * because it failed, so hiding the footer would recreate the abrupt-end
 * confusion this indicator exists to fix.
 */
function shouldShowElapsedFooter(
  runState: ChatMessageRunState | null,
  completedAt: number | null,
  last: MessageSegment | undefined,
  stopped: ChatMessageStoppedInfo | null,
): boolean {
  if (runState !== null) return false;
  if (completedAt === null) return false;
  if (stopped !== null) return true;
  if (last !== undefined && last.kind === "error") return false;
  return true;
}

/**
 * The last segment the row DRAWS on its own - the one the footer asks about.
 *
 * `segments` is the list the row renders (the notices this client hides
 * already left out), and `absorbedNoticeId` - the settled notice the anchor
 * error's card paints - is skipped too. A routing settlement appends its
 * notice AFTER the failed turn's error block, so the raw last block gave a
 * failed turn a success footer: under the settled card, and under the
 * failed-turn card once the user's own refusal wrote its (hidden) notice.
 */
function lastSegmentDrawnOnItsOwn(
  segments: ReadonlyArray<MessageSegment>,
  absorbedNoticeId: string | null,
): MessageSegment | undefined {
  return segments.findLast((segment) => segment.id !== absorbedNoticeId);
}

/**
 * Stop-button pictogram for a stopped turn - a faint destructive circle with
 * a smaller solid destructive rounded square centered inside, matching the
 * composer's stop button in miniature. A plain outline square at footer size
 * previously read as an empty checkbox.
 */
function StopBadge() {
  return (
    <span
      aria-hidden
      data-testid="assistant-stop-badge"
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-destructive/15"
    >
      <Square className="size-1.5 rounded-xs fill-destructive text-destructive" />
    </span>
  );
}

function StoppedBeforeResponding() {
  return (
    <div
      role="status"
      aria-label="Stopped before responding"
      data-testid="assistant-stopped-before-responding"
      className="flex w-fit items-center gap-1.5 py-1 text-ui-sm text-destructive"
    >
      <StopBadge />
      <span>Stopped before responding</span>
    </div>
  );
}

const NO_FOLDED_BACKGROUND_EVENTS: ReadonlyArray<FoldedBackgroundEvent> = [];

/** What the background card heading this row shows in its foot. */
interface BackgroundCardContent {
  readonly ending: BackgroundEventCardEnding | null;
  readonly folded: ReadonlyArray<FoldedBackgroundEvent>;
}

type BackgroundCardInput = {
  readonly silentAutonomousResume: boolean;
  readonly showCompletionFooter: boolean;
  readonly autonomousResumeOwed: boolean;
  readonly runState: ChatMessageRunState | null;
  readonly completedAt: number | null;
  readonly elapsedStartedAt: number;
  readonly pausedDurationMs: number;
  readonly meta: AssistantTurnMeta | null;
  readonly foldedBackgroundEvents:
    | ReadonlyArray<FoldedBackgroundEvent>
    | undefined;
};

function backgroundCardContent(
  input: BackgroundCardInput,
): BackgroundCardContent {
  return {
    ending: silentBackgroundEventEnding(input),
    folded: input.foldedBackgroundEvents ?? NO_FOLDED_BACKGROUND_EVENTS,
  };
}

/**
 * How a finished turn that is nothing but a background event ended, for its
 * card to say: "No reply · Ns" when a provider turn ran and said nothing, with
 * the turn's details behind it, or "Agent not resumed" when no turn picked the
 * event up - the CLI had already delivered it, or the host's retries for it
 * ran out. Without one, the card is the last thing in the transcript and
 * nothing says the agent is finished.
 *
 * `null` while the turn runs, and while the host still owes the event to the
 * agent (`autonomousResumeOwed`): until then "not resumed" would be a verdict
 * on something that has not ended.
 */
function silentBackgroundEventEnding(
  input: BackgroundCardInput,
): BackgroundEventCardEnding | null {
  if (
    !input.silentAutonomousResume ||
    input.runState !== null ||
    input.completedAt === null
  ) {
    return null;
  }
  if (!input.showCompletionFooter && input.autonomousResumeOwed) return null;
  const value = backgroundEventEnding({
    showCompletionFooter: input.showCompletionFooter,
    completedAt: input.completedAt,
    elapsedStartedAt: input.elapsedStartedAt,
    pausedDurationMs: input.pausedDurationMs,
  });
  return {
    value,
    details:
      value.kind === "no-reply" ? (
        <AssistantMetaTooltip
          meta={input.meta}
          stopped={null}
          startedAt={input.elapsedStartedAt}
          completedAt={input.completedAt}
        />
      ) : null,
  };
}

/**
 * The background event that started this row's turn: the last of the
 * turn-start deliveries at its head, which is the card whose foot says how
 * the turn ended and lists what was folded into it. `null` for a row no
 * background event started.
 */
function headBackgroundEventSegmentId(
  segments: ReadonlyArray<MessageSegment>,
): string | null {
  let id: string | null = null;
  for (const segment of segments) {
    if (
      segment.kind !== "autonomous_resume" ||
      segment.deliveryPlacement === "in_turn"
    ) {
      break;
    }
    id = segment.id;
  }
  return id;
}

/**
 * Leading glyph for the elapsed footer. A stopped turn always shows the
 * filled stop glyph, never the provider icon - natural footers keep the
 * provider mark (legacy turns with no metadata fall back to the spark).
 */
function AssistantElapsedFooterIcon({
  stopped,
  meta,
}: {
  stopped: ChatMessageStoppedInfo | null;
  meta: AssistantTurnMeta | null;
}) {
  if (stopped !== null) return <StopBadge />;
  return meta === null ? (
    <Sparkles className="size-3.5 shrink-0" aria-hidden />
  ) : (
    <HarnessIcon harnessId={meta.provider} className="size-3.5" />
  );
}

function AssistantElapsedFooter({
  messageId,
  createdAt,
  pausedDurationMs,
  completedAt,
  stopped,
  meta,
  replyText,
  boundaryReplySegments,
  forkAction,
}: {
  messageId: string;
  createdAt: number;
  pausedDurationMs: number;
  completedAt: number | null;
  stopped: ChatMessageStoppedInfo | null;
  meta: AssistantTurnMeta | null;
  replyText: string;
  /** The turn's reply when this row does not draw it (a stopped boundary). */
  boundaryReplySegments: ReadonlyArray<MessageSegment> | null;
  forkAction: ChatMessageForkAction | null;
}) {
  if (completedAt === null) return null;
  // One rule for both endings: a Stop gets no separate truncated-at-click
  // timer, it uses the same `completedAt - createdAt - pausedDurationMs` as a
  // natural finish. It still READS as truncated at the click, because the
  // projection resolves a stopped turn's `completedAt` to the stop instant
  // itself - `assistantTurnTiming` takes `stoppedAt ?? persistedCompletedAt`,
  // and its one call site always passes `stoppedAt` when the row is stopped.
  // So the stop's wind-down is excluded by the DATA, not by a second formula.
  const elapsedMs = completedAt - createdAt - pausedDurationMs;
  const verb = pickElapsedVerb(messageId);
  const nonStoppedElapsedLabel = `${verb} for ${formatWorkedFor(elapsedMs)}`;
  const elapsedContent = (
    <>
      <AssistantElapsedFooterIcon stopped={stopped} meta={meta} />
      {stopped !== null ? (
        <span className="text-ui-sm leading-5">
          <span className="text-destructive">Stopped</span>
          {` · ${formatWorkedFor(elapsedMs)}`}
        </span>
      ) : (
        <span className="text-ui-sm leading-5">{nonStoppedElapsedLabel}</span>
      )}
    </>
  );
  // Hovering the whole footer reveals the turn's details (provider, model,
  // reasoning effort, fast mode, and when it ran) - no separate info icon, so
  // the row stays clean. `w-fit` keeps the hover target tight to the text.
  //
  // Always a button, never a bare div: every completed turn now has timing to
  // disclose, so there is no such thing as a footer with nothing behind it,
  // and the button is what puts the card on the keyboard path as well as the
  // pointer's.
  const elapsed = (
    <button
      type="button"
      data-testid="assistant-elapsed-footer"
      className="flex w-fit cursor-default items-center gap-1.5 py-0.5 text-ui-sm text-muted-foreground/70"
    >
      {elapsedContent}
    </button>
  );
  // The tooltip wraps only the elapsed text, not the copy button, so the copy
  // hit-target stays its own affordance rather than re-triggering the details
  // card.
  const elapsedWithTooltip = (
    <TooltipWrapper
      label={
        <AssistantMetaTooltip
          meta={meta}
          stopped={stopped}
          startedAt={createdAt}
          completedAt={completedAt}
        />
      }
      side="top"
      align="start"
      sideOffset={6}
    >
      {elapsed}
    </TooltipWrapper>
  );
  return (
    <div className="flex items-center gap-1">
      {elapsedWithTooltip}
      {replyText.length > 0 ? (
        <AssistantReplyCopyButton text={replyText} />
      ) : null}
      {replyText.length > 0 ? (
        <ReplyReadAloudButton boundaryReplySegments={boundaryReplySegments} />
      ) : null}
      {forkAction !== null ? <AssistantForkButton action={forkAction} /> : null}
    </div>
  );
}

/**
 * Always-visible muted copy button trailing the elapsed footer. Mirrors the
 * segment copy affordance but without the hover-reveal gate, so the finished
 * reply is one click away.
 */
function AssistantReplyCopyButton({ text }: { text: string }) {
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });
  const onClick = useCallback(() => copy(text), [copy, text]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy reply"}
      data-testid="assistant-reply-copy"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground/60 transition-colors",
        "hover:bg-accent hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * Play/Stop for reading the reply aloud with the device's own voices. Absent
 * where the device has no speech engine or no on-device voice.
 */
function ReadAloudButton({
  readParagraphs,
}: {
  readParagraphs: (button: HTMLButtonElement | null) => ReadonlyArray<string>;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const read = useCallback(
    () => readParagraphs(buttonRef.current),
    [readParagraphs],
  );
  const { available, reading, toggle } = useReadAloud(read);
  if (!available) return null;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={toggle}
      aria-label={reading ? "Stop reading" : "Read reply aloud"}
      data-testid="assistant-reply-read-aloud"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground/60 transition-colors",
        "hover:bg-accent hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {reading ? (
        <Square className="size-3" aria-hidden />
      ) : (
        <Volume2 className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * A content-less boundary row (synthesized after a trailing steer bubble) has
 * no reply of its own; the turn's reply is on its earlier rows. `null` for
 * every row that draws its reply.
 */
function boundaryReplySegmentsOf(
  segments: ReadonlyArray<MessageSegment>,
  stopped: ChatMessageStoppedInfo | null,
): ReadonlyArray<MessageSegment> | null {
  return segments.length === 0 && stopped !== null && stopped.turnHadOutput
    ? stopped.turnReplySegments
    : null;
}

/**
 * Speech reads what the reply shows. A row that draws its reply reads its own
 * rendered DOM; a boundary row projects the reply its earlier rows draw.
 */
function ReplyReadAloudButton({
  boundaryReplySegments,
}: {
  boundaryReplySegments: ReadonlyArray<MessageSegment> | null;
}) {
  if (boundaryReplySegments === null) {
    return <ReadAloudButton readParagraphs={readRenderedReply} />;
  }
  return <BoundaryReplyReadAloudButton segments={boundaryReplySegments} />;
}

/** The row draws its reply: read what it shows, from its own DOM. */
function readRenderedReply(
  button: HTMLButtonElement | null,
): ReadonlyArray<string> {
  const turn = button?.closest("[data-assistant-turn]") ?? null;
  return turn === null ? [] : spokenParagraphsFromRenderedReply(turn);
}

const UNRESOLVED_AGENT_LABEL: AgentLabelResolver = () => null;

/**
 * A stopped-boundary row's Play/Stop. Its reply is drawn by earlier rows of
 * the turn, which the virtualized transcript may have unmounted, so it is
 * projected from the same parsed parts those rows render. Agent references
 * resolve as their chips do, and read as written with no open epic.
 */
function BoundaryReplyReadAloudButton({
  segments,
}: {
  segments: ReadonlyArray<MessageSegment>;
}) {
  return (
    <EpicSessionGate
      fallback={
        <BoundaryReplyReadAloud
          segments={segments}
          resolveAgentLabel={UNRESOLVED_AGENT_LABEL}
        />
      }
    >
      <ResolvedBoundaryReplyReadAloud segments={segments} />
    </EpicSessionGate>
  );
}

function ResolvedBoundaryReplyReadAloud({
  segments,
}: {
  segments: ReadonlyArray<MessageSegment>;
}) {
  const records = useEpicArtifactRecords();
  const roleClaimsByAgentId = useEpicAgentRoleClaimsByAgentId();
  const resolveAgentLabel = useCallback<AgentLabelResolver>(
    (referenceId) =>
      resolveAgentReference({ referenceId, records, roleClaimsByAgentId })
        ?.label ?? null,
    [records, roleClaimsByAgentId],
  );
  return (
    <BoundaryReplyReadAloud
      segments={segments}
      resolveAgentLabel={resolveAgentLabel}
    />
  );
}

function BoundaryReplyReadAloud({
  segments,
  resolveAgentLabel,
}: {
  segments: ReadonlyArray<MessageSegment>;
  resolveAgentLabel: AgentLabelResolver;
}) {
  const readParagraphs = useCallback(
    () =>
      spokenParagraphsFromReplyMarkdown(
        collectAssistantReplyMarkdowns(segments),
        resolveAgentLabel,
      ),
    [resolveAgentLabel, segments],
  );
  return <ReadAloudButton readParagraphs={readParagraphs} />;
}

function AssistantForkButton({
  action,
}: {
  readonly action: ChatMessageForkAction;
}) {
  const label = "Fork conversation";
  return (
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={label}
        data-testid="assistant-fork-chat"
        disabled={!action.enabled || action.pending}
        onClick={() => action.onFork("plain", null)}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground/60 transition-colors",
          "hover:bg-accent hover:text-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60",
        )}
      >
        <Split className="size-3.5 rotate-90" aria-hidden />
      </button>
    </TooltipWrapper>
  );
}

/**
 * Hover content for the elapsed footer: provider, profile, model, reasoning
 * effort, and fast mode (only when enabled); then when the turn ran and when
 * it finished; then - for a user-stopped turn - the stop time and reason from
 * the `turn.stopped` event. Mirrors the context-usage chip's label/value row
 * layout so the two tooltips read consistently.
 *
 * Timing answers what the visible footer deliberately does not: the footer
 * states a DURATION, and a single clock time next to a duration cannot say
 * which end of it it names. Two labelled rows can, and they also cover the
 * turns whose start no user row records - a queued message, an autonomous
 * wakeup, an agent-to-agent send. Every completed footer has it, which is why
 * the footer no longer has an un-hoverable variant.
 *
 * A stopped turn's end row is `Stopped at`, REPLACING `Finished` rather than
 * joining it. The projection resolves a stopped turn's `completedAt` to the
 * stop instant itself (`assistantTurnTiming`'s `stoppedAt ?? persisted`), so
 * rendering both would print one instant twice under two labels and invite
 * the reader to look for a difference that is not there.
 *
 * `startedAt` is `null` for a row whose `createdAt` is a synthetic sort
 * anchor rather than a real instant - the pre-turn pending indicator, whose
 * anchor is "newest row + 1ms" and is epoch+1 on an empty transcript. Such a
 * row states no time at all: a live turn already shows an elapsed counter,
 * and a wrong start is worse than no start.
 */
function AssistantMetaTooltip({
  meta,
  stopped,
  startedAt,
  completedAt,
}: {
  meta: AssistantTurnMeta | null;
  stopped: ChatMessageStoppedInfo | null;
  startedAt: number | null;
  completedAt: number | null;
}) {
  const reasoning = meta?.reasoningEffortLabel ?? null;
  return (
    // Tooltip surface is `bg-foreground text-background`, so all text here must
    // be tinted off `background` (using `foreground` would be invisible).
    <div className="flex min-w-36 flex-col gap-1.5 text-ui-xs">
      {meta === null ? null : (
        <>
          <div className="border-b border-background/20 pb-1.5 font-medium">
            Agent
          </div>
          <AssistantMetaRow label="Provider" value={meta.providerLabel} />
          {/* Either field alone is enough to justify the row. Gating on
              `profileLabel` alone silently dropped the credential disclosure
              on exactly the turns that most need it: a turn whose session
              anchor is missing or harness-mismatched has no label, and if an
              env credential ALSO won there, the bypass notice vanished with
              the row. */}
          {meta.profileLabel === null &&
          meta.envCredentialVar === null ? null : (
            <AssistantMetaRow
              label="Profile"
              value={assistantProfileMetaValue(meta)}
            />
          )}
          {meta.modelLabel === null ? null : (
            <AssistantMetaRow label="Model" value={meta.modelLabel} />
          )}
          {reasoning === null ? null : (
            <AssistantMetaRow label="Reasoning" value={reasoning} />
          )}
          <AssistantSpeedMetaRow meta={meta} />
          {meta.costUsd !== null && meta.costUsd > 0 ? (
            <AssistantMetaRow label="Cost" value={formatUsd(meta.costUsd)} />
          ) : null}
        </>
      )}
      {startedAt === null ? null : (
        <AssistantTimingSection
          startedAt={startedAt}
          completedAt={completedAt}
          stopped={stopped}
          dividerAbove={meta !== null}
        />
      )}
      <AssistantStoppedSection
        stopped={stopped}
        dividerAbove={meta !== null || startedAt !== null}
      />
    </div>
  );
}

function AssistantSpeedMetaRow(props: { readonly meta: AssistantTurnMeta }) {
  const { meta } = props;
  if (!isFastModeEnabled(meta.serviceTier)) return null;
  return (
    <AssistantMetaRow
      label="Speed"
      value={meta.serviceTierLabel ?? meta.serviceTier ?? ""}
    />
  );
}

/**
 * Compact USD formatter for the cost row: sub-dollar turns show 4 decimals
 * ("$0.0123"); a positive amount too small to show at 4 decimals reads
 * "<$0.0001" rather than a misleading "$0.0000"; >= $1 shows 2 decimals.
 */
function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value < 0.0001) return "<$0.0001";
  // A sub-dollar value that rounds up to 1 at 4 decimals (e.g. 0.99999 ->
  // "1.0000") should read "$1.00", not the misleading "$1.0000".
  const rounded = value.toFixed(4);
  return Number(rounded) >= 1 ? `$${value.toFixed(2)}` : `$${rounded}`;
}

/**
 * The Profile row's value, annotated when an environment variable - not the
 * named profile - is what actually authenticated the turn:
 * `Terminal account (bypassed — env: ANTHROPIC_API_KEY)`.
 *
 * The bare label alone answers "which account ran this?" WRONG in that case,
 * because a provider CLI prefers an env key/token over its own signed-in store.
 * Annotating in place rather than adding a separate row keeps the correction
 * attached to the claim it corrects - a reader who skims one line still gets the
 * true answer.
 *
 * Rendered ONLY for a positive `envCredentialVar`. Absence is a real claim (the
 * profile sign-in was used), so it needs no badge of its own - and a turn
 * persisted before the field existed reads as absent, so a "signed in normally"
 * marker here would be asserting something those rows never recorded.
 *
 * With no profile label (an anchor-less or harness-mismatched turn) the value
 * still has to carry the disclosure, so it states the credential directly
 * rather than prefixing an empty string and leaking a leading space.
 */
function assistantProfileMetaValue(meta: AssistantTurnMeta): string {
  if (meta.envCredentialVar === null) return meta.profileLabel ?? "";
  if (meta.profileLabel === null) {
    return `env: ${meta.envCredentialVar} (sign-in bypassed)`;
  }
  return `${meta.profileLabel} (bypassed — env: ${meta.envCredentialVar})`;
}

/**
 * How a turn ENDED, named for the way it ended rather than for the slot it
 * occupies. A stopped turn's end is the stop itself: the projection resolves
 * its `completedAt` to the stop instant, so "Finished" and "Stopped at" would
 * be one time printed twice. `null` is a turn with no end yet.
 */
function assistantTurnEndRow(
  stopped: ChatMessageStoppedInfo | null,
  completedAt: number | null,
): { readonly label: string; readonly at: number } | null {
  if (stopped !== null) return { label: "Stopped at", at: stopped.stoppedAt };
  if (completedAt === null) return null;
  return { label: "Finished", at: completedAt };
}

/**
 * The card's Timing section. Its own component so the shared clock is
 * subscribed only where a time is actually rendered - a card with no timing
 * to show (the pre-turn indicator) reads no clock at all. Radix keeps tooltip
 * content unmounted at rest, so even then it is the hovered row subscribing,
 * never every finished turn in the transcript.
 */
function AssistantTimingSection({
  startedAt,
  completedAt,
  stopped,
  dividerAbove,
}: {
  startedAt: number;
  completedAt: number | null;
  stopped: ChatMessageStoppedInfo | null;
  dividerAbove: boolean;
}) {
  const now = useSampledNow();
  const end = assistantTurnEndRow(stopped, completedAt);
  return (
    <>
      <div
        className={cn(
          "font-medium",
          dividerAbove && "border-t border-background/20 pt-1.5",
        )}
      >
        Timing
      </div>
      <AssistantMetaRow
        label="Started"
        value={formatMessageTimeWithSeconds(startedAt, now)}
      />
      {end === null ? null : (
        <AssistantMetaRow
          label={end.label}
          value={formatMessageTimeWithSeconds(end.at, now)}
        />
      )}
    </>
  );
}

/**
 * The stop's own section, which survives only to carry the reason - not a
 * timing fact, and with nowhere else to go. With no reason recorded there is
 * nothing to put here at all: `Stopped at` in the Timing section above
 * already says everything the stop knows, and a bare header would announce a
 * section with no rows.
 */
function AssistantStoppedSection({
  stopped,
  dividerAbove,
}: {
  stopped: ChatMessageStoppedInfo | null;
  dividerAbove: boolean;
}) {
  if (stopped === null || stopped.reason === null) return null;
  return (
    <>
      <div
        className={cn(
          "font-medium",
          dividerAbove && "border-t border-background/20 pt-1.5",
        )}
      >
        Stopped
      </div>
      <AssistantMetaRow label="Reason" value={stopped.reason} />
    </>
  );
}

function AssistantMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-background/65">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/**
 * Past-tense verbs rotated per turn so the footer reads playfully rather than
 * mechanically (Claude Code CLI pattern). Seeded by `messageId` (stable per
 * turn AND distinct between sibling turns sharing one user-send) so the verb
 * never flips on re-render and never collides on adjacent rows.
 */
const ELAPSED_VERBS = [
  "Cogitated",
  "Pondered",
  "Crunched",
  "Brewed",
  "Noodled",
  "Mulled",
  "Schemed",
  "Hatched",
  "Tinkered",
  "Conjured",
  "Distilled",
  "Wrangled",
  "Marinated",
  "Riffed",
  "Sleuthed",
  "Plotted",
  "Stewed",
  "Forged",
  "Spelunked",
  "Channeled",
] as const;

function pickElapsedVerb(seed: string): string {
  // djb2 - fast, well-distributed for short strings, no allocation.
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % ELAPSED_VERBS.length;
  return ELAPSED_VERBS[index] ?? ELAPSED_VERBS[0];
}

function AssistantRunIndicator({
  runState,
  createdAt,
  pausedDurationMs,
  pausedSinceMs,
  messageId,
  meta,
}: {
  runState: ChatMessageRunState;
  createdAt: number;
  pausedDurationMs: number;
  pausedSinceMs: number | null;
  messageId: string;
  meta: AssistantTurnMeta | null;
}) {
  // The tile latches the send-seeded verb across the host row remount.
  const runVerb = use(WorkingVerbContext);
  const verb =
    runState === "stopping"
      ? "Stopping"
      : (runVerb ?? pickWorkingVerb(messageId));
  const indicator = (
    <div
      data-testid="assistant-run-indicator"
      data-run-state={runState}
      className="flex w-fit items-center gap-1.5 py-1 text-ui-sm text-muted-foreground"
    >
      {/* Leading icon names the running provider; the 3-dot loader trails the
          shimmering verb at the text baseline (like "Pondering…") to carry the
          "in progress" cue. */}
      {meta === null ? null : (
        <HarnessIcon harnessId={meta.provider} className="size-3.5" />
      )}
      <span className="inline-flex items-baseline gap-1">
        <WorkingShimmerText className="text-ui-sm" animationOrigin={createdAt}>
          {verb}
        </WorkingShimmerText>
        {/* 3-dot typing loader rather than the braille spinner: three steady,
            sequentially-pulsing dots instead of a morphing glyph. */}
        <AgentSpinningDots
          className={undefined}
          testId="assistant-run-dots"
          variant="typing"
          animationOrigin={createdAt}
        />
      </span>
      {/* Separate node so the once-per-second tick re-renders ONLY the timer,
          not the shimmering verb, the dots, or the rest of the body. */}
      <RunElapsedTimer
        startMs={createdAt}
        pausedDurationMs={pausedDurationMs}
        pausedSinceMs={pausedSinceMs}
      />
    </div>
  );
  if (meta === null) return indicator;
  return (
    <TooltipWrapper
      label={
        // No Timing on the pre-turn indicator: this row's `createdAt` is a
        // synthetic list anchor ("newest row + 1ms"), not an instant the turn
        // actually started at, and the live counter beside it already answers
        // how long the turn has been going.
        <AssistantMetaTooltip
          meta={meta}
          stopped={null}
          startedAt={null}
          completedAt={null}
        />
      }
      side="top"
      align="start"
      sideOffset={6}
    >
      {indicator}
    </TooltipWrapper>
  );
}

function RunElapsedTimer({
  startMs,
  pausedDurationMs,
  pausedSinceMs,
}: {
  startMs: number;
  pausedDurationMs: number;
  pausedSinceMs: number | null;
}) {
  const elapsedSeconds = useElapsedSeconds(
    startMs,
    pausedDurationMs,
    pausedSinceMs,
  );
  return (
    <span className="tabular-nums">
      ({formatClockDuration(elapsedSeconds)})
    </span>
  );
}

export interface AssistantSegmentProps {
  id: string;
  segment: MessageSegment;
  backgroundToolBlockIds: ReadonlySet<string>;
  nextStepActions: NextStepActionHandler | null;
  forkAction: ChatMessageForkAction | null;
  interviewDeliveryRetry: InterviewDeliveryRetryAction | null;
  /** Harness that ran this turn, for provider-targeted error affordances. */
  harnessId: GuiHarnessId | null;
  /** See `AssistantBodyProps.turnId`. */
  turnId: string | null;
  /** The settled notice the anchor error absorbs; `null` on every other item. */
  settledNotice: RoutingSettledNotice | null;
  settledNoticeFindUnitId: string | null;
  /**
   * What the background card that started this turn shows in its foot, on
   * that one `autonomous_resume` segment; `null` on every other item. Read
   * by no other segment kind.
   */
  backgroundCard: BackgroundCardContent | null;
}

function ApprovalSegmentCard({
  findUnitId,
  segment,
}: {
  findUnitId: string;
  segment: Extract<MessageSegment, { kind: "approval" }>;
}) {
  // Pending approvals are routed to the composer-slot queue by the timeline
  // builder; this is reached only for resolved decisions.
  if (segment.decision === null) return null;
  return (
    <ResolvedApprovalSegment
      toolName={segment.toolName}
      description={segment.description}
      inputSummary={segment.inputSummary}
      inputDetail={segment.inputDetail}
      decision={segment.decision}
      variant="card"
      headerFindUnitId={findUnitId}
      initiallyOpen={false}
    />
  );
}

// Renders one of many assistant segment kinds; the branch count is the segment
// taxonomy (one arm per kind), not reducible nesting. Exported because a
// subagent card draws its own conversation through this same renderer
// (`SubagentConversation`), so a child reads exactly as it would top-level.
// eslint-disable-next-line complexity
export function AssistantSegment({
  id,
  segment,
  backgroundToolBlockIds,
  nextStepActions,
  forkAction,
  interviewDeliveryRetry,
  harnessId,
  turnId,
  settledNotice,
  settledNoticeFindUnitId,
  backgroundCard,
}: AssistantSegmentProps) {
  const findUnitId = chatFindSegmentUnitId(id);
  switch (segment.kind) {
    case "text":
      if (segment.browserSession !== undefined) {
        return (
          <BrowserSessionRow
            session={segment.browserSession}
            findUnitId={findUnitId}
          />
        );
      }
      return (
        <TextSegment
          findUnitId={findUnitId}
          markdown={segment.markdown}
          isStreaming={segment.isStreaming}
          nextStepActions={nextStepActions}
          imageContext={segment.assistantImageContext}
        />
      );
    case "reasoning":
      // Unreachable from the timeline - `isActivitySegment` admits reasoning
      // unconditionally, so every reasoning block reaches the renderer through
      // an activity group. Kept so the switch stays exhaustive over the segment
      // taxonomy, and for direct renders in tests.
      return (
        <ReasoningSegment
          findUnitId={findUnitId}
          markdown={segment.markdown}
          isStreaming={segment.isStreaming}
          durationMs={segment.durationMs}
          bodyBoundedByParent={false}
          headerless={false}
          initiallyExpanded={false}
        />
      );
    case "tool": {
      const isBackgroundRunning = backgroundToolBlockIds.has(segment.id);
      return (
        <ToolSegment
          id={segment.id}
          toolName={segment.toolName}
          inputSummary={segment.inputSummary}
          inputDetail={segment.inputDetail}
          error={segment.error}
          agentMessageSend={segment.agentMessageSend}
          managedCommand={segment.managedCommand}
          agentMessageReceipt={segment.agentMessageReceipt}
          agentMessageDelivery={segment.agentMessageDelivery}
          isStreaming={segment.isStreaming || isBackgroundRunning}
          endState={isBackgroundRunning ? null : segment.endState}
          stopped={segment.stopped}
          progress={segment.progress}
          backgroundOutput={segment.backgroundOutput}
          backgroundTask={segment.backgroundTask}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          imageResults={segment.imageResults}
          artifact={segment.artifact}
          mcpApp={segment.mcpApp}
          variant="card"
          headerFindUnitId={
            segment.agentMessageSend === null ? findUnitId : null
          }
        />
      );
    }
    case "file_change":
      return (
        <FileChangeSegment
          segment={segment}
          variant="card"
          headerFindUnitId={findUnitId}
          initiallyOpen={false}
        />
      );
    case "file_change_group":
      return (
        <FileChangeGroupSegment
          files={segment.files}
          artifacts={segment.artifacts}
          checkpointManifest={segment.checkpointManifest}
          hasLaterOverlappingChanges={segment.hasLaterOverlappingChanges}
          findUnitId={findUnitId}
        />
      );
    case "command": {
      // Same treatment as a promoted tool call: while the host still lists the
      // command as running background work, the card keeps reading "running"
      // even though the turn that spawned it already finalized its blocks.
      const isBackgroundRunning = backgroundToolBlockIds.has(segment.id);
      return (
        <CommandSegment
          command={segment.command}
          cwd={segment.cwd}
          exitCode={segment.exitCode}
          isStreaming={segment.isStreaming || isBackgroundRunning}
          endState={isBackgroundRunning ? null : segment.endState}
          stopped={segment.stopped}
          progress={segment.progress}
          startedAt={segment.startedAt}
          variant="card"
          headerFindUnitId={findUnitId}
          initiallyOpen={false}
        />
      );
    }
    case "subagent":
      return (
        <SubagentSegment
          id={id}
          cardId={segment.id}
          toolImageResults={segment.toolImageResults}
          name={segment.name}
          agentType={segment.agentType}
          task={segment.task}
          progressUpdates={segment.progressUpdates}
          result={segment.result}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          stopped={segment.stopped}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          workflowMeta={segment.workflowMeta}
          nested={segment.children}
          variant="card"
        />
      );
    case "approval":
      return <ApprovalSegmentCard segment={segment} findUnitId={findUnitId} />;
    case "artifact_operation":
      return (
        <ArtifactCardSegment
          operation={segment.operation}
          artifactKind={segment.artifactKind}
          artifactId={segment.artifactId}
          title={segment.title}
          change={segment.change}
          findUnitId={findUnitId}
        />
      );
    case "todo":
      return <TodoSegment items={segment.items} findUnitId={findUnitId} />;
    case "plan":
      return <PlanSegment segment={segment} findUnitId={findUnitId} />;
    case "error":
      return (
        <ErrorSegment
          message={segment.message}
          code={segment.code}
          recoverable={segment.recoverable}
          findUnitId={findUnitId}
          harnessId={harnessId}
          failure={segment.failure}
          turnId={turnId}
          settledNotice={settledNotice}
          settledNoticeFindUnitId={settledNoticeFindUnitId}
        />
      );
    case "compaction":
      return (
        <CompactionSegment
          status={segment.status}
          notApplied={segment.notApplied}
          trigger={segment.trigger}
          preTokens={segment.preTokens}
          postTokens={segment.postTokens}
          durationMs={segment.durationMs}
          summary={segment.summary}
          error={segment.error}
          findUnitId={findUnitId}
        />
      );
    case "provider_notice":
      // Every notice kind is the one hairline divider, `fallback_wait_resumed`
      // included (clutter cuts, 2026-09-27): "Resumed on Surya 2 after the
      // limit reset" reads the way the applied notice does, with its details
      // under the same chevron, rather than as a bordered card of its own.
      return (
        <ProviderNoticeSegment
          status={segment.status}
          noticeKind={segment.noticeKind}
          presentation={segment.presentation}
          tone={segment.tone}
          title={segment.title}
          message={segment.message}
          details={segment.details}
          findUnitId={findUnitId}
        />
      );
    case "autonomous_resume":
      return (
        <AutonomousResumeSegment
          triggers={segment.triggers}
          variant="card"
          ending={backgroundCard?.ending ?? null}
          folded={backgroundCard?.folded ?? NO_FOLDED_BACKGROUND_EVENTS}
        />
      );
    case "interview":
      return (
        <InterviewSegment
          blockId={segment.id}
          status={segment.status}
          questions={segment.questions}
          answers={segment.answers}
          draftAnswers={segment.draftAnswers}
          outcome={segment.outcome}
          settlement={segment.settlement}
          error={segment.error}
          delivery={segment.delivery}
          forkedWithoutAnswer={segment.forkedWithoutAnswer}
          forkAction={forkAction}
          interviewDeliveryRetry={interviewDeliveryRetry}
        />
      );
    case "setup-card":
      // The setup card only ever rides a synthesized `role: "system"` row,
      // never an assistant turn's segments; it's rendered by `ChatMessage`'s
      // top-level branch. Listed here so the exhaustive switch stays complete.
      return null;
    case "forked-chat-link":
      // Fork provenance only ever rides a synthesized `role: "system"` row,
      // never an assistant turn's segments; it is rendered by `ChatMessage`.
      return null;
    case "imported-chat-marker":
      // Import provenance, same as the fork link above: synthesized system row
      // only. Listed here so the exhaustive switch stays complete.
      return null;
    case "auto-judge-unattended-denial":
      // An auto-mode refusal nobody was asked about: synthesized system row
      // only, like the two above. Listed here so the switch stays exhaustive.
      return null;
    case "auto-judge-notice":
      // A judge notice: synthesized system row only, like the refusal above.
      return null;
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return null;
    }
  }
}

function indicatorMessageId(input: {
  readonly workingVerbSeed: string | undefined;
  readonly messageId: string;
}): string {
  return input.workingVerbSeed ?? input.messageId;
}
