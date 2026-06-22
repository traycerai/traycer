import { Check, FilePenLine, X } from "lucide-react";
import type { ChatFileEditApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ComposerSlotFileEditApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
}

export function ComposerSlotFileEditApprovalQueue(
  props: ComposerSlotFileEditApprovalQueueProps,
) {
  const count = props.approvals.length;
  if (count === 0) return null;
  const showBulk = count >= 2;
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-ui-sm"
      data-testid="file-edit-approval-prompt"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FilePenLine
          className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <span className="select-none font-medium uppercase text-amber-800 text-overline dark:text-amber-200">
          File edit approval
        </span>
        {showBulk ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="text-ui-xs text-muted-foreground">
              {count} pending
            </span>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!props.canAct}
                onClick={() => {
                  for (const approval of props.approvals) {
                    props.onDecision(approval.approvalId, false);
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
                disabled={!props.canAct}
                onClick={() => {
                  for (const approval of props.approvals) {
                    props.onDecision(approval.approvalId, true);
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
        {props.approvals.map((approval) => (
          <FileEditApprovalRow
            key={approval.approvalId}
            approval={approval}
            canAct={props.canAct}
            onDecision={props.onDecision}
          />
        ))}
      </div>
    </div>
  );
}

interface FileEditApprovalRowProps {
  readonly approval: ChatFileEditApprovalState;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
}

function FileEditApprovalRow(props: FileEditApprovalRowProps) {
  const headline =
    props.approval.description.length > 0
      ? props.approval.description
      : props.approval.toolName;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-code-sm text-foreground/80">
          {props.approval.toolName}
        </span>
        <Badge
          variant="outline"
          className={cn(
            "h-4 px-1 text-overline",
            operationBadgeClassName(props.approval.operation),
          )}
        >
          {operationLabel(props.approval.operation)}
        </Badge>
      </div>
      <p className="m-0 text-foreground/85">{headline}</p>
      {props.approval.paths.length > 0 ? (
        <ul className="m-0 flex min-w-0 flex-col gap-1 p-0">
          {props.approval.paths.map((filePath) => (
            <li
              key={filePath}
              className="min-w-0 truncate rounded-sm bg-canvas/70 px-2 py-1 font-mono text-code-sm text-canvas-foreground/80"
              title={filePath}
            >
              {filePath}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-muted-foreground">No file paths reported.</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!props.canAct}
          onClick={() => {
            props.onDecision(props.approval.approvalId, false);
          }}
        >
          <X className="size-3.5" aria-hidden />
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={!props.canAct}
          onClick={() => {
            props.onDecision(props.approval.approvalId, true);
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
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (operation === "delete") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
}
