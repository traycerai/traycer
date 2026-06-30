import { Check, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deriveToolInputSummary } from "@/lib/segment-summary";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";

interface ComposerSlotApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
}

/**
 * Single canonical surface for ALL pending approvals - one row when there
 * is one, N rows when many. Replaces the prior split where a single
 * approval lived in the composer slot and ≥2 spilled inline. Keeps the
 * action surface consistent regardless of queue depth.
 */
export function ComposerSlotApprovalQueue(
  props: ComposerSlotApprovalQueueProps,
) {
  const { approvals, canAct, onDecision } = props;
  const count = approvals.length;
  if (count === 0) return null;
  const showBulk = count >= 2;
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 text-ui-sm"
      data-testid="approval-prompt"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="select-none font-medium uppercase text-overline text-primary">
          Approval needed
        </span>
        {showBulk ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="text-ui-xs text-muted-foreground">
              {count} pending
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canAct}
                onClick={() => {
                  for (const approval of approvals) {
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
                  for (const approval of approvals) {
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
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
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
    </div>
  );
}
