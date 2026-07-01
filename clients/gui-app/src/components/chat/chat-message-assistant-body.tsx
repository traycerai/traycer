import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import { chatFindSegmentUnitId } from "@/components/chat/chat-find";
import {
  WorkingVerbContext,
  pickWorkingVerb,
} from "@/components/chat/working-verb";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type {
  AssistantTurnMeta,
  ChatMessageRunState,
  MessageSegment,
} from "@/stores/composer/chat-store";
import { Check, Copy, GitBranch, Sparkles } from "lucide-react";
import { use, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { formatClockDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import type { ChatMessageForkAction } from "./chat-message";
import { ActivityGroupSegment } from "./segments/activity-group-segment";
import { ResolvedApprovalSegment } from "./segments/approval-segment";
import { ArtifactCardSegment } from "./segments/artifact-card-segment";
import { CommandSegment } from "./segments/command-segment";
import { CompactionSegment } from "./segments/compaction-segment";
import { AutonomousResumeSegment } from "./segments/autonomous-resume-segment";
import { ErrorSegment } from "./segments/error-segment";
import { FileChangeGroupSegment } from "./segments/file-change-group-segment";
import { FileChangeSegment } from "./segments/file-change-segment";
import { InterviewSegment } from "./segments/interview-segment";
import type { NextStepActionHandler } from "./segments/next-steps-action-group";
import { PlanSegment } from "./segments/plan-segment";
import { ReasoningSegment } from "./segments/reasoning-segment";
import { SubagentSegment } from "./segments/subagent-segment";
import { TextSegment } from "./segments/text-segment";
import { TodoSegment } from "./segments/todo-segment";
import { ToolSegment } from "./segments/tool-segment";

const COPIED_RESET_MS = 1600;

const handleCopyError = (): void => {
  toast.error("Couldn't copy to clipboard.");
};

/**
 * Plain-text reply of a finished turn: the visible answer is the `text`
 * segments, joined with blank lines. Reasoning, tool calls, and file-change
 * blocks are intentionally excluded so "copy reply" yields the prose the
 * assistant actually addressed to the user.
 */
function collectAssistantReplyText(
  segments: ReadonlyArray<MessageSegment>,
): string {
  return segments
    .flatMap((segment) => (segment.kind === "text" ? [segment.markdown] : []))
    .join("\n\n")
    .trim();
}

interface AssistantBodyProps {
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
  /** Wall-clock turn start; `completedAt - createdAt` is the elapsed duration. */
  createdAt: number;
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
   * Per-turn agent run metadata (provider, model, reasoning effort, fast mode)
   * surfaced through the elapsed footer's info tooltip. `null` for turns that
   * predate the persisted run-metadata fields.
   */
  meta: AssistantTurnMeta | null;
  nextStepActions: NextStepActionHandler | null;
  forkAction: ChatMessageForkAction | null;
}

export function AssistantMessageBody({
  segments,
  backgroundToolBlockIds,
  runState,
  messageId,
  createdAt,
  pausedDurationMs,
  pausedSinceMs,
  completedAt,
  meta,
  nextStepActions,
  forkAction,
}: AssistantBodyProps) {
  const activityTimelineTurnState = runState === null ? "complete" : "active";
  const timeline = useMemo(
    () =>
      buildChatActivityTimeline(segments, {
        turnState: activityTimelineTurnState,
        promotedToolBlockIds: backgroundToolBlockIds,
      }),
    [activityTimelineTurnState, backgroundToolBlockIds, segments],
  );
  const replyText = useMemo(
    () => collectAssistantReplyText(segments),
    [segments],
  );
  // No content yet. While the turn is live (`runState` non-null) show the
  // in-progress indicator for the pre-first-token gap. Once the turn has ended
  // (`runState === null`) - e.g. stopped before producing any output - show the
  // empty-turn note instead, NEVER a "Working…" indicator that would stick.
  if (segments.length === 0) {
    return runState === null ? null : (
      <AssistantRunIndicator
        runState={runState}
        createdAt={createdAt}
        pausedDurationMs={pausedDurationMs}
        pausedSinceMs={pausedSinceMs}
        messageId={messageId}
        meta={meta}
      />
    );
  }
  return (
    <div className="flex w-full max-w-none flex-col gap-2 py-1 @container">
      {timeline.map((item) => {
        if (item.kind === "activity_group") {
          return <ActivityGroupSegment key={item.id} group={item.group} />;
        }
        if (item.kind === "answered_questions") {
          return (
            <InterviewSegment
              key={item.id}
              findUnitId={chatFindSegmentUnitId(item.segment.id)}
              status={item.segment.status}
              toolName={item.segment.toolName}
              title={item.segment.title}
              description={item.segment.description}
              questions={item.segment.questions}
              answers={item.segment.answers}
              error={item.segment.error}
            />
          );
        }
        if (item.kind === "promoted_subagent") {
          return (
            <SubagentSegment
              key={item.id}
              id={item.id}
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
              variant="promoted"
            />
          );
        }
        return (
          <AssistantSegment
            key={item.id}
            id={item.id}
            segment={item.segment}
            backgroundToolBlockIds={backgroundToolBlockIds}
            nextStepActions={nextStepActions}
          />
        );
      })}
      {/* Trailing indicator keeps the in-progress cue visible for the whole
          turn once content has started streaming, not just the empty gap. */}
      {runState !== null ? (
        <AssistantRunIndicator
          runState={runState}
          createdAt={createdAt}
          pausedDurationMs={pausedDurationMs}
          pausedSinceMs={pausedSinceMs}
          messageId={messageId}
          meta={meta}
        />
      ) : null}
      {shouldShowElapsedFooter(runState, completedAt, segments) ? (
        <AssistantElapsedFooter
          messageId={messageId}
          createdAt={createdAt}
          pausedDurationMs={pausedDurationMs}
          completedAt={completedAt}
          meta={meta}
          replyText={replyText}
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
 * error as a successful run).
 */
function shouldShowElapsedFooter(
  runState: ChatMessageRunState | null,
  completedAt: number | null,
  segments: ReadonlyArray<MessageSegment>,
): boolean {
  if (runState !== null) return false;
  if (completedAt === null) return false;
  const last = segments.at(-1);
  if (last !== undefined && last.kind === "error") return false;
  return true;
}

function AssistantElapsedFooter({
  messageId,
  createdAt,
  pausedDurationMs,
  completedAt,
  meta,
  replyText,
  forkAction,
}: {
  messageId: string;
  createdAt: number;
  pausedDurationMs: number;
  completedAt: number | null;
  meta: AssistantTurnMeta | null;
  replyText: string;
  forkAction: ChatMessageForkAction | null;
}) {
  if (completedAt === null) return null;
  const elapsedMs = completedAt - createdAt - pausedDurationMs;
  const verb = pickElapsedVerb(messageId);
  // Hovering the whole footer reveals the agent run details (provider, model,
  // reasoning effort, fast mode) - no separate info icon, so the row stays
  // clean. `w-fit` keeps the hover target tight to the text.
  const elapsed = (
    <div
      data-testid="assistant-elapsed-footer"
      className="flex w-fit cursor-default items-center gap-1.5 py-0.5 text-ui-sm text-muted-foreground/70"
    >
      {/* The provider's mono icon names which agent ran without needing the
          hover tooltip; legacy turns with no metadata fall back to the spark. */}
      {meta === null ? (
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <HarnessIcon harnessId={meta.provider} className="size-3.5" />
      )}
      <span className="text-ui-sm leading-5">
        {verb} for {formatWorkedFor(elapsedMs)}
      </span>
    </div>
  );
  // The meta tooltip wraps only the elapsed text, not the copy button, so the
  // copy hit-target stays its own affordance rather than re-triggering the
  // agent-details popover.
  const elapsedWithTooltip =
    meta === null ? (
      elapsed
    ) : (
      <TooltipWrapper
        label={<AssistantMetaTooltip meta={meta} />}
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
        onClick={action.onFork}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground/60 transition-colors",
          "hover:bg-accent hover:text-foreground",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60",
        )}
      >
        <GitBranch className="size-3.5" aria-hidden />
      </button>
    </TooltipWrapper>
  );
}

/**
 * Hover content for the elapsed-footer info icon: provider, model, reasoning
 * effort, and fast mode (only when enabled). Mirrors the context-usage chip's
 * label/value row layout so the two tooltips read consistently.
 */
function AssistantMetaTooltip({ meta }: { meta: AssistantTurnMeta }) {
  const reasoning = meta.reasoningEffortLabel;
  const fastModeEnabled = isFastModeEnabled(meta.serviceTier);
  return (
    // Tooltip surface is `bg-foreground text-background`, so all text here must
    // be tinted off `background` (using `foreground` would be invisible).
    <div className="flex min-w-36 flex-col gap-1.5 text-ui-xs">
      <div className="border-b border-background/20 pb-1.5 font-medium">
        Agent
      </div>
      <AssistantMetaRow label="Provider" value={meta.providerLabel} />
      {meta.modelLabel === null ? null : (
        <AssistantMetaRow label="Model" value={meta.modelLabel} />
      )}
      {reasoning === null ? null : (
        <AssistantMetaRow label="Reasoning" value={reasoning} />
      )}
      {fastModeEnabled ? (
        <AssistantMetaRow label="Fast mode" value="On" />
      ) : null}
      {meta.costUsd !== null && meta.costUsd > 0 ? (
        <AssistantMetaRow label="Cost" value={formatUsd(meta.costUsd)} />
      ) : null}
    </div>
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

function AssistantMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-background/65">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/**
 * Fast mode is on whenever the turn carried a non-default service tier (e.g.
 * Codex `"priority"`); an empty/null tier means the harness default.
 */
function isFastModeEnabled(serviceTier: string | null): boolean {
  return serviceTier !== null && serviceTier.trim().length > 0;
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

/**
 * Format an elapsed duration for the "Worked for Nm Xs" footer.
 *
 * Named distinctly from the dictation-bar's `formatElapsed` (M:SS stopwatch
 * format) so an unqualified import never picks the wrong formatter.
 *
 * - Non-finite / negative inputs (clock skew, replay anomalies) → "<1s",
 *   visually distinct from a sub-1s real-fast turn (which reads "<1s" too -
 *   acceptable since both convey "negligible duration" without the misleading
 *   "0s" rounding from `Math.round`).
 * - 1ms..999ms → "<1s".
 * - 1s..59s → "Ns".
 * - 1m..59m → "Nm Xs".
 * - 1h+    → "Nh Nm Xs".
 */
function formatWorkedFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  return formatClockDuration(Math.floor(ms / 1000));
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
  // Resolved once per turn by the chat tile (seeded on the chat + turn ordinal,
  // not the row id) so the word stays fixed for the whole turn even as the
  // pre-turn placeholder swaps to the real turn id. Freeze on "Stopping" the
  // moment a stop is requested. Falls back to a `messageId` seed outside a chat
  // (isolated component tests).
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
        <span className="working-text-shimmer text-ui-sm">{verb}</span>
        <WorkingDots />
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
      label={<AssistantMetaTooltip meta={meta} />}
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

/**
 * 3-dot typing loader for the in-progress cue (pure CSS - see the `.working-dots`
 * rules in index.css). Replaces the braille spinner so the indicator shows three
 * steady, sequentially-pulsing dots rather than a morphing glyph.
 */
function WorkingDots() {
  return (
    <span
      className="working-dots text-current"
      aria-hidden="true"
      data-testid="assistant-run-dots"
    >
      <span />
      <span />
      <span />
    </span>
  );
}

interface AssistantSegmentProps {
  id: string;
  segment: MessageSegment;
  backgroundToolBlockIds: ReadonlySet<string>;
  nextStepActions: NextStepActionHandler | null;
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
    />
  );
}

// Renders one of many assistant segment kinds; the branch count is the segment
// taxonomy (one arm per kind), not reducible nesting.
// eslint-disable-next-line complexity
function AssistantSegment({
  id,
  segment,
  backgroundToolBlockIds,
  nextStepActions,
}: AssistantSegmentProps) {
  const findUnitId = chatFindSegmentUnitId(id);
  switch (segment.kind) {
    case "text":
      return (
        <TextSegment
          findUnitId={findUnitId}
          markdown={segment.markdown}
          isStreaming={segment.isStreaming}
          nextStepActions={nextStepActions}
        />
      );
    case "reasoning":
      return (
        <ReasoningSegment
          findUnitId={findUnitId}
          markdown={segment.markdown}
          isStreaming={segment.isStreaming}
          durationMs={segment.durationMs}
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
          isStreaming={segment.isStreaming || isBackgroundRunning}
          endState={isBackgroundRunning ? null : segment.endState}
          stopped={segment.stopped}
          progress={segment.progress}
          backgroundOutput={segment.backgroundOutput}
          backgroundTask={segment.backgroundTask}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
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
    case "command":
      return (
        <CommandSegment
          command={segment.command}
          cwd={segment.cwd}
          exitCode={segment.exitCode}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          progress={segment.progress}
          startedAt={segment.startedAt}
          variant="card"
          headerFindUnitId={findUnitId}
        />
      );
    case "subagent":
      return (
        <SubagentSegment
          id={id}
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
          findUnitId={findUnitId}
        />
      );
    case "compaction":
      return (
        <CompactionSegment
          status={segment.status}
          trigger={segment.trigger}
          preTokens={segment.preTokens}
          postTokens={segment.postTokens}
          durationMs={segment.durationMs}
          summary={segment.summary}
          error={segment.error}
          findUnitId={findUnitId}
        />
      );
    case "autonomous_resume":
      return <AutonomousResumeSegment triggers={segment.triggers} />;
    case "interview":
      return (
        <InterviewSegment
          findUnitId={findUnitId}
          status={segment.status}
          toolName={segment.toolName}
          title={segment.title}
          description={segment.description}
          questions={segment.questions}
          answers={segment.answers}
          error={segment.error}
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
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return null;
    }
  }
}
