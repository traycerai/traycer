import {
  Check,
  ChevronDown,
  Folder,
  Globe,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import type { RuntimeApprovalDecision } from "@traycer/protocol/host/agent/gui/agent-runtime";

interface ComposerSlotApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => void;
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
      className="flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm text-ui-sm"
      data-testid="approval-prompt"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-2.5">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" aria-hidden />
        <span className="select-none font-medium uppercase tracking-wider text-overline text-foreground/80">
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
                    onDecision(approval.approvalId, { approved: false });
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
                    onDecision(approval.approvalId, { approved: true });
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
      <div className="flex flex-col divide-y divide-border/40 px-3 py-1">
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
  readonly onDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => void;
}

function ApprovalRow(props: ApprovalRowProps) {
  const { approval, canAct, onDecision } = props;
  // The exact invocation being approved (`ls -la /x`). When the host couldn't
  // resolve one (non-command tools), fall back to the description so the prompt
  // is never empty about what it's asking for.
  const commandPreview =
    approval.commandPreview !== null && approval.commandPreview.length > 0
      ? approval.commandPreview
      : null;
  // Generic per-tool description (e.g. "Traycer requests bash permission").
  // Demoted to muted context once a concrete command is shown above it.
  const description =
    approval.description.length > 0 ? approval.description : null;
  // "Always allow" is offered only when the host attached a concrete rule it
  // would save (`suggestedRule`): command tools whose command tokenizes safely.
  // Non-command tools and un-tokenizable commands send `null` and get no
  // affordance, mirroring that the host would persist nothing.
  const suggestedRule = approval.suggestedRule;
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-2 last:pb-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <Badge
          variant="secondary"
          className="font-mono text-xs text-foreground/80 bg-muted/50 hover:bg-muted/50 border border-border/40"
        >
          {approval.toolName}
        </Badge>
        {description !== null ? (
          <span className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      {commandPreview !== null ? (
        <div className="flex max-h-[min(30vh,9rem)] flex-col overflow-auto rounded-md border border-border/50 bg-muted/30">
          <div className="flex w-full items-start gap-3 px-3 py-2.5">
            <span className="shrink-0 select-none font-mono text-code-sm text-muted-foreground/40 mt-px">
              $
            </span>
            <code className="min-w-0 flex-1 font-mono text-code-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
              {commandPreview}
            </code>
          </div>
        </div>
      ) : null}
      {commandPreview === null && description === null ? (
        <p className="m-0 text-foreground/85">{approval.toolName}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 mt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canAct}
          onClick={() => {
            onDecision(approval.approvalId, { approved: false });
          }}
        >
          <X className="size-3.5" aria-hidden />
          Deny
        </Button>
        {suggestedRule !== null ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canAct}
              >
                <ShieldCheck className="size-3.5" aria-hidden />
                Always allow
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[min(80vw,13rem)]"
            >
              <DropdownMenuLabel className="font-normal">
                <span className="text-ui-xs text-muted-foreground">
                  Always allow{" "}
                  <code className="font-mono text-code-sm text-foreground">
                    {suggestedRule}
                  </code>
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  onDecision(approval.approvalId, {
                    approved: true,
                    remember: { scope: "workspace" },
                  });
                }}
              >
                <Folder className="size-3.5 shrink-0" aria-hidden />
                <div className="flex min-w-0 flex-col">
                  <span>This workspace</span>
                  <span className="text-ui-xs text-muted-foreground">
                    Only for this workspace
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2"
                onSelect={() => {
                  onDecision(approval.approvalId, {
                    approved: true,
                    remember: { scope: "global" },
                  });
                }}
              >
                <Globe className="size-3.5 shrink-0" aria-hidden />
                <div className="flex min-w-0 flex-col">
                  <span>All workspaces</span>
                  <span className="text-ui-xs text-muted-foreground">
                    Across all workspaces
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={!canAct}
          onClick={() => {
            onDecision(approval.approvalId, { approved: true });
          }}
        >
          <Check className="size-3.5" aria-hidden />
          Approve
        </Button>
      </div>
    </div>
  );
}
