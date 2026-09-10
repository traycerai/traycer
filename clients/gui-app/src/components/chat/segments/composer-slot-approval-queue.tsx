import { Check, Gavel, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { deriveToolInputSummary } from "@/lib/segment-summary";
import { humanActionableApprovals } from "@/components/epic-canvas/renderers/chat-approval-visibility";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";

interface ComposerSlotApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
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
    <div
      className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 text-ui-sm"
      data-testid="approval-prompt"
    >
      <div className="flex items-center gap-2">
        <HeaderIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="select-none font-medium uppercase text-overline text-primary">
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
}

function ApprovalRow(props: ApprovalRowProps) {
  const { approval, canAct, onDecision } = props;
  const inputSummary = deriveToolInputSummary(
    approval.toolName,
    approval.input,
  );
  const headline =
    approval.description.length > 0 ? approval.description : approval.toolName;
  const reviewing = approval.reviewing;
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 py-2 first:pt-0 last:pb-0"
      data-testid="approval-row"
      data-approval-id={approval.approvalId}
    >
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
        // 19). The state rides the subscribe frame only, so it disappears on
        // its own the moment the judge allows the call or releases it here.
        <div
          className="flex items-center gap-2 text-ui-xs text-muted-foreground"
          data-testid="approval-reviewing"
          role="status"
        >
          <AgentSpinningDots
            className="text-muted-foreground"
            testId={undefined}
            variant={undefined}
          />
          {JUDGE_REVIEWING_LABEL[reviewing]}
        </div>
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
 * The judge's verdict on a call it escalated: the rule it matched as a chip,
 * its own reasoning underneath.
 *
 * A card that said only "approve this?" after a judge already refused it is
 * strictly worse than one that never ran a judge, because the user cannot tell
 * why they are being asked - so this renders wherever the reason is present,
 * including on a row that is no longer reviewing.
 */
function JudgeReason(props: { readonly rule: string; readonly text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-foreground/5 px-2 py-0.5 text-ui-xs text-foreground/85">
        <Gavel className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{props.rule}</span>
      </span>
      <p className="m-0 whitespace-pre-wrap text-ui-xs text-muted-foreground">
        {props.text}
      </p>
    </div>
  );
}
