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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deriveToolInputSummary } from "@/lib/segment-summary";
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
      className="flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm text-ui-sm"
      data-testid="approval-prompt"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3.5 py-3">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" aria-hidden />
        <span className="select-none font-semibold uppercase tracking-wider text-[11px] text-foreground/80">
          Action Requires Approval
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
                disabled={!canAct}
                className="h-7 px-2.5 text-xs shadow-none bg-background/50 hover:bg-background"
                onClick={() => {
                  approvals.forEach((approval) =>
                    onDecision(approval.approvalId, { approved: false }),
                  );
                }}
              >
                <X className="size-3" aria-hidden />
                Deny all
              </Button>
              <Button
                type="button"
                variant="default"
                disabled={!canAct}
                className="h-7 px-2.5 text-xs shadow-none"
                onClick={() => {
                  approvals.forEach((approval) =>
                    onDecision(approval.approvalId, { approved: true }),
                  );
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
  // Concise "what" derived from the tool input (path, url, …) for non-command
  // tools, where the host resolves no command preview. Used as the last-resort
  // line so such approvals still say what they act on.
  const inputSummary =
    commandPreview === null
      ? deriveToolInputSummary(approval.toolName, approval.input)
      : null;
  // "Always allow" is offered only when the host attached concrete rule(s) it
  // would save (`suggestedRules`): command tools whose every segment tokenizes
  // safely. Non-command tools and un-tokenizable/chained-unsafe commands send an
  // empty list and get no affordance, mirroring that the host would persist
  // nothing. A chained command (`npm run lint || exit 1`) yields several rules.
  // Deduped so identical rules can't collide as React keys (and repeats aren't
  // shown twice in the "Rules to save" list). A chained command can derive the
  // same rule from more than one segment.
  const suggestedRules = [...new Set(approval.suggestedRules)];
  return (
    <div className="flex flex-col gap-3.5 p-3.5 first:pt-3.5 border-b border-border/20 last:border-0 bg-card/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <Badge
          variant="secondary"
          className="font-mono text-[10px] uppercase tracking-wide text-foreground/70 bg-muted/60 hover:bg-muted/60 border border-border/40 px-1.5 py-0 h-5 rounded-sm"
        >
          {approval.toolName}
        </Badge>
        {description !== null ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">
            {description}
          </span>
        ) : null}
      </div>
      {commandPreview !== null ? (
        <div className="flex max-h-[min(30vh,9rem)] w-full items-start gap-3 overflow-auto rounded-md border border-border/40 bg-muted/30 px-3 py-2.5 shadow-sm">
          <span className="shrink-0 select-none font-mono text-code-sm text-muted-foreground/30 mt-px">
            ›
          </span>
          <code className="min-w-0 flex-1 font-mono text-code-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
            {commandPreview}
          </code>
        </div>
      ) : null}
      {commandPreview === null && inputSummary !== null ? (
        <p className="m-0 font-mono text-code-sm break-words text-muted-foreground">
          {inputSummary}
        </p>
      ) : null}
      {commandPreview === null &&
      description === null &&
      inputSummary === null ? (
        <p className="m-0 text-xs text-foreground/85">{approval.toolName}</p>
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
        {suggestedRules.length > 0 ? (
          <div className="flex -space-x-px shadow-sm rounded-md">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canAct}
              className="rounded-r-none focus:z-10 shadow-none bg-background hover:bg-muted/50 border-r-0"
              onClick={() => {
                onDecision(approval.approvalId, {
                  approved: true,
                  remember: { scope: "workspace" },
                });
              }}
            >
              <ShieldCheck className="size-3.5 text-primary" aria-hidden />
              Always allow
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canAct}
                  className="rounded-l-none px-2 focus:z-10 shadow-none bg-background hover:bg-muted/50"
                  aria-label="More allow options"
                >
                  <ChevronDown
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={6}
                collisionPadding={8}
                className="w-[min(90vw,20rem)] p-0 overflow-hidden rounded-lg shadow-lg"
              >
                <div className="flex flex-col gap-1.5 bg-muted/40 px-3.5 py-3 border-b border-border/40 max-h-[30vh] overflow-y-auto">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {suggestedRules.length > 1
                      ? "Rules to save"
                      : "Rule to save"}
                  </span>
                  <div className="flex flex-col gap-1.5 mt-1">
                    {suggestedRules.map((rule) => (
                      <div
                        key={rule}
                        className="flex items-center gap-2 rounded bg-background/50 border border-border/40 px-2 py-1.5 shadow-sm"
                      >
                        <span className="shrink-0 text-muted-foreground/50 select-none text-[10px]">
                          ›
                        </span>
                        <code className="text-[11px] font-mono text-foreground/90 break-all leading-snug">
                          {rule}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-1.5 flex flex-col gap-0.5 max-h-[40vh] overflow-y-auto">
                  <DropdownMenuItem
                    className="gap-3 p-2.5 cursor-pointer items-start rounded-md focus:bg-muted"
                    onSelect={() => {
                      onDecision(approval.approvalId, {
                        approved: true,
                        remember: { scope: "workspace" },
                      });
                    }}
                  >
                    <Folder
                      className="size-4 shrink-0 text-muted-foreground mt-0.5"
                      aria-hidden
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium leading-none text-foreground/90">
                        This workspace
                      </span>
                      <span className="text-xs text-muted-foreground leading-snug">
                        Save for this project only
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-3 p-2.5 cursor-pointer items-start rounded-md focus:bg-muted"
                    onSelect={() => {
                      onDecision(approval.approvalId, {
                        approved: true,
                        remember: { scope: "global" },
                      });
                    }}
                  >
                    <Globe
                      className="size-4 shrink-0 text-muted-foreground mt-0.5"
                      aria-hidden
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium leading-none text-foreground/90">
                        All workspaces
                      </span>
                      <span className="text-xs text-muted-foreground leading-snug">
                        Save everywhere on this host
                      </span>
                    </div>
                  </DropdownMenuItem>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
