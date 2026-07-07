import { Check, FilePenLine, Zap, X } from "lucide-react";
import type { ChatFileEditApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import type { RuntimeApprovalDecision } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ComposerSlotFileEditApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => void;
  // Flip the chat/epic into `auto_accept_edits` mode: every edit in every chat
  // of this epic auto-approves from here on (persisted + applied to the live
  // turn). The single "always allow edits" affordance — there is no per-rule
  // edit grant.
  readonly onAutoAcceptEdits: () => void;
}

export function ComposerSlotFileEditApprovalQueue(
  props: ComposerSlotFileEditApprovalQueueProps,
) {
  const count = props.approvals.length;
  if (count === 0) return null;
  const showBulk = count >= 2;
  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm text-ui-sm"
      data-testid="file-edit-approval-prompt"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3.5 py-3">
        <FilePenLine className="size-4 shrink-0 text-amber-500" aria-hidden />
        <span className="select-none font-semibold uppercase tracking-wider text-[11px] text-foreground/80">
          File Edit Approval
        </span>
        {showBulk ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
              {count} pending
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!props.canAct}
                className="h-7 px-2.5 text-xs shadow-none bg-background/50 hover:bg-background"
                onClick={() => {
                  for (const approval of props.approvals) {
                    props.onDecision(approval.approvalId, { approved: false });
                  }
                }}
              >
                <X className="size-3" aria-hidden />
                Deny all
              </Button>
              <Button
                type="button"
                variant="default"
                disabled={!props.canAct}
                className="h-7 px-2.5 text-xs shadow-none"
                onClick={() => {
                  for (const approval of props.approvals) {
                    props.onDecision(approval.approvalId, { approved: true });
                  }
                }}
              >
                <Check className="size-3" aria-hidden />
                Approve all
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <div className="flex flex-col divide-y divide-border/30">
        {props.approvals.map((approval) => (
          <FileEditApprovalRow
            key={approval.approvalId}
            approval={approval}
            canAct={props.canAct}
            onDecision={props.onDecision}
            onAutoAcceptEdits={props.onAutoAcceptEdits}
          />
        ))}
      </div>
    </div>
  );
}

interface FileEditApprovalRowProps {
  readonly approval: ChatFileEditApprovalState;
  readonly canAct: boolean;
  readonly onDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => void;
  readonly onAutoAcceptEdits: () => void;
}

function FileEditApprovalRow(props: FileEditApprovalRowProps) {
  const description =
    props.approval.description.length > 0 ? props.approval.description : null;
  return (
    <div className="flex flex-col gap-3.5 p-3.5 first:pt-3.5 border-b border-border/20 last:border-0 bg-card/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <Badge
          variant="secondary"
          className="font-mono text-[10px] uppercase tracking-wide text-foreground/70 bg-muted/60 hover:bg-muted/60 border border-border/40 px-1.5 py-0 h-5 rounded-sm"
        >
          {props.approval.toolName}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "h-5 px-1.5 py-0 text-[10px] uppercase tracking-wide rounded-sm",
            operationBadgeClassName(props.approval.operation),
          )}
        >
          {operationLabel(props.approval.operation)}
        </Badge>
        {description !== null ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">
            {description}
          </span>
        ) : null}
      </div>

      {props.approval.paths.length > 0 ? (
        <div className="flex flex-col gap-1 w-full rounded-md border border-border/40 bg-muted/30 px-3 py-2.5 shadow-sm max-h-[min(30vh,9rem)] overflow-auto">
          {props.approval.paths.map((filePath) => (
            <div key={filePath} className="flex items-start gap-3 min-w-0">
              <span className="shrink-0 select-none font-mono text-code-sm text-muted-foreground/30 mt-px">
                ›
              </span>
              <code className="min-w-0 flex-1 font-mono text-code-sm leading-relaxed break-all text-foreground/90">
                {filePath}
              </code>
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">
          No file paths reported.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 mt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!props.canAct}
          onClick={() => {
            props.onDecision(props.approval.approvalId, { approved: false });
          }}
        >
          <X className="size-3.5" aria-hidden />
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!props.canAct}
          className="bg-background hover:bg-muted/50 focus:z-10 shadow-sm"
          onClick={() => {
            props.onAutoAcceptEdits();
            props.onDecision(props.approval.approvalId, { approved: true });
          }}
          title="Auto-accept every edit in this epic from now on"
        >
          <Zap className="size-3.5 text-primary" aria-hidden />
          Auto-accept edits
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={!props.canAct}
          onClick={() => {
            props.onDecision(props.approval.approvalId, { approved: true });
          }}
        >
          <Check className="size-3.5" aria-hidden />
          Approve
        </Button>
      </div>
    </div>
  );
}

function operationLabel(
  operation: ChatFileEditApprovalState["operation"],
): string {
  if (operation === "create") return "Create";
  if (operation === "delete") return "Delete";
  return "Edit";
}

function operationBadgeClassName(
  operation: ChatFileEditApprovalState["operation"],
): string {
  if (operation === "create") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (operation === "delete") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400";
}
