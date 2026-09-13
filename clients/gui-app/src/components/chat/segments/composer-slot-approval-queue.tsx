import { useRef } from "react";
import { Check, Gavel, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
  useRestartHighlightPulse,
} from "@/components/chat/chat-navigation-highlight";
import { deriveToolInputSummary } from "@/lib/segment-summary";
import { humanActionableApprovals } from "@/components/epic-canvas/renderers/chat-approval-visibility";
import {
  APPROVAL_PAUSED_LINE,
  approvalWaitLine,
  isJudgeUnavailableReason,
  judgeUnavailableHumanLine,
  judgeWaitDisclosure,
} from "@/components/chat/segments/approval-card-disclosure";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";

interface ComposerSlotApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
  readonly highlightedApprovalId: string | null;
  readonly highlightedGeneration?: number;
}

/**
 * Copy for each judge stage, keyed by `ChatApprovalState.reviewing`.
 *
 * Two stages, two very different waits: the fast pass answers within seconds,
 * the deep one reads the transcript and may run for minutes, so the row says
 * which one is running rather than showing one generic "Reviewing…" for both.
 */
const JUDGE_REVIEWING_LABEL: Record<
  NonNullable<ChatApprovalState["reviewing"]>,
  string
> = {
  checking: "Checking…",
  reviewing: "Judge reviewing the transcript…",
};

/**
 * Single canonical surface for ALL pending approvals - one row when there
 * is one, N rows when many. Replaces the prior split where a single
 * approval lived in the composer slot and ≥2 spilled inline. Keeps the
 * action surface consistent regardless of queue depth.
 *
 * Under the `auto` permission mode a row can be here without being a question:
 * an approval a judge is still deciding rides the same list carrying
 * `reviewing`, and renders its stage with no buttons (plan decision 19 - there
 * is no human override while the judge runs; the stage-2 cap bounds the wait).
 * The bulk actions therefore act on - and count - only the rows a human can
 * actually answer, so "Approve all" can never resolve a call the judge is still
 * thinking about.
 */
export function ComposerSlotApprovalQueue(
  props: ComposerSlotApprovalQueueProps,
) {
  const { approvals, canAct, onDecision } = props;
  const count = approvals.length;
  if (count === 0) return null;
  const actionable = humanActionableApprovals(approvals);
  const showBulk = actionable.length >= 2;
  // Nothing is needed from the user while every row is still with the judge, so
  // the heading does not claim otherwise. It flips to "Approval needed" the
  // moment one row is actually answerable - including the same card's other
  // rows, which is the common case in a queue of several calls.
  const awaitingJudgeOnly = actionable.length === 0;
  const HeaderIcon = awaitingJudgeOnly ? Gavel : ShieldAlert;
  return (
    // The chrome follows the same flag as the heading, and that is the whole
    // fix for the post-retirement flicker: once an allowed command retires its
    // own card, EVERY judged command puts a row on screen for the ~5 s stage-1
    // spawn. A five-second muted line saying what the pause is for is good
    // feedback; a five-second bordered, primary-tinted alert with an uppercase
    // overline saying the same thing is what makes a working feature feel like
    // it is malfunctioning. The alarm is in the chrome, not in the row's
    // existence - so the full alert returns the instant any row becomes
    // answerable, which this flag already tracks. No timer and no hold: a
    // threshold delay would open a race where a retire arriving during the
    // hold lets the card appear AFTER the allow.
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2.5 text-ui-sm",
        awaitingJudgeOnly
          ? "border-border/60"
          : "border-primary/40 bg-primary/5",
      )}
      data-testid="approval-prompt"
      data-chrome={awaitingJudgeOnly ? "quiet" : "alert"}
    >
      <div className="flex items-center gap-2">
        <HeaderIcon
          className={cn(
            "size-3.5 shrink-0",
            awaitingJudgeOnly ? "text-muted-foreground" : "text-primary",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "select-none",
            awaitingJudgeOnly
              ? "text-ui-xs text-muted-foreground"
              : "font-medium uppercase text-overline text-primary",
          )}
        >
          {awaitingJudgeOnly ? "Judge review" : "Approval needed"}
        </span>
        {showBulk ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="text-ui-xs text-muted-foreground">
              {actionable.length} pending
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canAct}
                onClick={() => {
                  for (const approval of actionable) {
                    onDecision(approval.approvalId, false);
                  }
                }}
              >
                <X className="size-3.5" aria-hidden />
                Deny all
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={!canAct}
                onClick={() => {
                  for (const approval of actionable) {
                    onDecision(approval.approvalId, true);
                  }
                }}
              >
                <Check className="size-3.5" aria-hidden />
                Approve all
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <div className="flex flex-col divide-y divide-border/30">
        {approvals.map((approval) => (
          <ApprovalRow
            key={approval.approvalId}
            approval={approval}
            canAct={canAct}
            onDecision={onDecision}
            navigationHighlighted={
              props.highlightedApprovalId === approval.approvalId
            }
            highlightGeneration={props.highlightedGeneration ?? 0}
          />
        ))}
      </div>
    </div>
  );
}

interface ApprovalRowProps {
  readonly approval: ChatApprovalState;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
  readonly navigationHighlighted: boolean;
  readonly highlightGeneration: number;
}

function ApprovalRow(props: ApprovalRowProps) {
  const { approval, canAct, onDecision } = props;
  const rowRef = useRef<HTMLDivElement | null>(null);
  useRestartHighlightPulse(
    props.navigationHighlighted,
    props.highlightGeneration,
    rowRef,
  );
  const inputSummary = deriveToolInputSummary(
    approval.toolName,
    approval.input,
  );
  const headline =
    approval.description.length > 0 ? approval.description : approval.toolName;
  const reviewing = approval.reviewing;
  return (
    <div
      ref={rowRef}
      data-testid="approval-row"
      data-approval-id={approval.approvalId}
      data-navigation-highlighted={
        props.navigationHighlighted ? "true" : undefined
      }
      data-navigation-highlight-generation={
        props.navigationHighlighted
          ? String(props.highlightGeneration)
          : undefined
      }
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md py-2 first:pt-0 last:pb-0 transition-[background-color,box-shadow] duration-300",
        props.navigationHighlighted && CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
      )}
    >
      {reviewing === null ? (
        <ApprovalWaitLine requestedAt={approval.requestedAt} />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-code-sm text-foreground/80">
        <span className="shrink-0">{approval.toolName}</span>
        {inputSummary !== null ? (
          <>
            <span aria-hidden className="shrink-0 text-muted-foreground/40">
              ·
            </span>
            <span className="min-w-0 break-words text-muted-foreground">
              {inputSummary}
            </span>
          </>
        ) : null}
      </div>
      <p className="m-0 text-foreground/85">{headline}</p>
      {approval.reason !== null ? (
        <JudgeReason rule={approval.reason.rule} text={approval.reason.text} />
      ) : null}
      {reviewing !== null ? (
        // No buttons and no override while a judge is deciding (plan decision
        // 19). The state rides the subscribe frame only, and the host retires
        // the row with its own resolution frame on every exit that announced
        // one - the allow, a Stop during stage 2, a failed journal write and
        // the agents-only denial alike.
        <JudgeReviewingLine
          stage={reviewing}
          startedAt={approval.requestedAt}
        />
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canAct}
            onClick={() => {
              onDecision(approval.approvalId, false);
            }}
          >
            <X className="size-3.5" aria-hidden />
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={!canAct}
            onClick={() => {
              onDecision(approval.approvalId, true);
            }}
          >
            <Check className="size-3.5" aria-hidden />
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * How long this card has been waiting on a human, once that is long enough to
 * be worth saying.
 *
 * The card a returning human finds is the point of the attendance rule: a chat
 * a person merely looked away from PARKS rather than being refused, which is
 * the right answer and is not free - the turn is now blocked on somebody who
 * is not there. This is what tells them so when they get back.
 *
 * Its own leaf so the shared 60s clock repaints this line rather than the row
 * around it.
 */
function ApprovalWaitLine(props: { readonly requestedAt: number }) {
  const nowMs = useSampledNow();
  const waited = approvalWaitLine({
    requestedAt: props.requestedAt,
    nowMs,
  });
  if (waited === null) return null;
  return (
    <p
      className="m-0 text-ui-xs text-muted-foreground"
      data-testid="approval-wait-line"
    >
      {waited} {APPROVAL_PAUSED_LINE}
    </p>
  );
}

/**
 * The judging row's stage label and its disclosure ladder.
 *
 * Its own leaf for the same reason as the wait line, and for one more: the
 * per-second tick lives only while a judge is actually running, because this
 * component is mounted only then.
 */
function JudgeReviewingLine(props: {
  readonly stage: NonNullable<ChatApprovalState["reviewing"]>;
  readonly startedAt: number;
}) {
  const elapsedSeconds = useElapsedSeconds(props.startedAt, 0, null);
  const disclosure = judgeWaitDisclosure(elapsedSeconds);
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="approval-reviewing"
      role="status"
    >
      <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId={undefined}
          variant={undefined}
        />
        {JUDGE_REVIEWING_LABEL[props.stage]}
        {disclosure.elapsedLabel !== null ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span data-testid="approval-reviewing-elapsed">
              {disclosure.elapsedLabel}
            </span>
          </>
        ) : null}
      </div>
      {disclosure.capNotice !== null ? (
        <p
          className="m-0 text-ui-xs text-muted-foreground"
          data-testid="approval-reviewing-cap"
        >
          {disclosure.capNotice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The judge's verdict on a call it escalated: the rule it matched as a chip,
 * its own reasoning underneath.
 *
 * A card that said only "approve this?" after a judge already refused it is
 * strictly worse than one that never ran a judge, because the user cannot tell
 * why they are being asked - so this renders wherever the reason is present,
 * including on a row that is no longer reviewing.
 *
 * When the reason is an UNAVAILABILITY string rather than the judge's prose,
 * the machine string is kept verbatim and in mono - it is a greppable constant,
 * and a screenshot of one is a diagnosis - and the human sentence is added
 * beneath it, never in its place. Which sentence is the string's own failure
 * family (`judgeUnavailableHumanLine`): a judge that ran and could not decide
 * leaves its reasoning right above this line, so the "couldn't run" sentence
 * would contradict the paragraph the user is reading.
 */
function JudgeReason(props: { readonly rule: string; readonly text: string }) {
  const unavailable = isJudgeUnavailableReason(props.text);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-foreground/5 px-2 py-0.5 text-ui-xs text-foreground/85">
        <Gavel className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{props.rule}</span>
      </span>
      <p
        className={cn(
          "m-0 whitespace-pre-wrap text-ui-xs text-muted-foreground",
          unavailable && "font-mono",
        )}
      >
        {props.text}
      </p>
      {unavailable ? (
        <p
          className="m-0 text-ui-xs text-muted-foreground"
          data-testid="approval-judge-unavailable-line"
        >
          {judgeUnavailableHumanLine(props.text)}
        </p>
      ) : null}
    </div>
  );
}
