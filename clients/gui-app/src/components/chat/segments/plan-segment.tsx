import {
  Check,
  CheckCircle2,
  CircleDashed,
  Clock,
  Copy,
  ExternalLink,
  FileWarning,
  Loader2,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { guiHarnessIdSchema } from "@traycer/protocol/host/index";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useChatPlanActions,
  type ChatPlanActionsContextValue,
} from "@/components/chat/chat-plan-actions-context";
import type { HostRpcRegistry } from "@/lib/host";
import { useAgentPlanQuery } from "@/hooks/agent/use-agent-plan-query";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { TraycerMarkdown } from "@/markdown";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import type { PlanSegmentModel } from "@/stores/composer/chat-store";
import {
  STATUS_ICON_TONE,
  segmentStepLabel,
} from "@/lib/chat/todo-status-tones";
import {
  PLAN_PREVIEW_STEP_LIMIT,
  PLAN_STATUS_LABELS,
  planCardSubtitle,
  planFallbackMarkdown,
  planHeadline,
} from "./plan-display";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface PlanSegmentProps {
  readonly segment: PlanSegmentModel;
  readonly findUnitId: string | null;
}

const COPIED_RESET_MS = 1600;

const STATUS_ICONS: Record<PlanSegmentModel["planStatus"], LucideIcon> = {
  drafting: Loader2,
  ready: CheckCircle2,
  awaiting_approval: Clock,
  approved: CheckCircle2,
  rejected: XCircle,
  superseded: FileWarning,
};

const handleCopyError = (): void => {
  toast.error("Couldn't copy to clipboard.");
};

export function PlanSegment(props: PlanSegmentProps) {
  const { findUnitId, segment } = props;
  const [open, setOpen] = useState(false);
  const planActions = useChatPlanActions();
  const markdownFallback = useMemo(
    () => planFallbackMarkdown(segment),
    [segment],
  );
  const cardHeadline = planHeadline(segment, markdownFallback);
  // Uniform plan action across harnesses: a live plan card shows a single
  // Implement button that sends a follow-up "implement the plan" message. Plan
  // mode is non-blocking (no approval gate), so there is no Reject action.
  const actionsVisible =
    segment.planStatus === "drafting" || segment.planStatus === "ready";
  const actionsDisabled =
    planActions === null || !planActions.canAct || planActions.pending;
  const handleImplement = useCallback(() => {
    planActions?.onImplement();
  }, [planActions]);
  const handleExpand = useCallback(() => setOpen(true), []);

  return (
    <>
      <PlanCard
        segment={segment}
        findUnitId={findUnitId ?? null}
        cardHeadline={cardHeadline}
        actionsVisible={actionsVisible}
        actionsDisabled={actionsDisabled}
        onImplement={handleImplement}
        onExpand={handleExpand}
      />
      <PlanModal
        segment={segment}
        planActions={planActions}
        markdownFallback={markdownFallback}
        open={open}
        onOpenChange={setOpen}
        actionsVisible={actionsVisible}
        actionsDisabled={actionsDisabled}
        onImplement={handleImplement}
      />
    </>
  );
}

function PlanCard(props: {
  readonly segment: PlanSegmentModel;
  readonly findUnitId: string | null;
  readonly cardHeadline: string;
  readonly actionsVisible: boolean;
  readonly actionsDisabled: boolean;
  readonly onImplement: () => void;
  readonly onExpand: () => void;
}) {
  const { segment, cardHeadline } = props;
  const cardSubtitle = planCardSubtitle(segment, cardHeadline);
  return (
    <article
      className={cn(
        "group/plan rounded-md border px-3 py-3 text-ui-sm shadow-sm transition-colors",
        planCardTone(segment.planStatus),
      )}
      data-testid="plan-segment"
      data-chat-find-unit={props.findUnitId ?? undefined}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <PlanHarnessIcon harnessId={segment.harnessId} />
            <h3 className="m-0 text-ui-lg font-semibold leading-snug text-foreground">
              {cardHeadline}
            </h3>
            <PlanStatusBadge
              planStatus={segment.planStatus}
              isStreaming={segment.isStreaming}
            />
          </div>
          {props.actionsVisible ? (
            <PlanActionButtons
              onImplement={props.onImplement}
              onExpand={props.onExpand}
              disabled={props.actionsDisabled}
              compact
            />
          ) : null}
        </div>

        {cardSubtitle !== null || segment.steps.length > 0 ? (
          <div className="space-y-2">
            <div>
              {cardSubtitle !== null ? (
                <p className="mt-1 m-0 text-ui-sm leading-6 text-foreground/80">
                  {cardSubtitle}
                </p>
              ) : null}
            </div>

            {segment.steps.length > 0 ? (
              <ul className="m-0 flex flex-col gap-1.5 p-0">
                {segment.steps
                  .slice(0, PLAN_PREVIEW_STEP_LIMIT)
                  .map((step, index) => (
                    <PlanStepRow
                      key={step.id ?? `${segment.id}:step:${index}`}
                      step={step}
                    />
                  ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function PlanStepRow(props: {
  readonly step: PlanSegmentModel["steps"][number];
}) {
  const { step } = props;
  const label = segmentStepLabel(step);
  return (
    <li className="flex min-w-0 items-start gap-2 text-foreground/85">
      <CircleDashed
        className={cn("mt-1 size-3.5 shrink-0", STATUS_ICON_TONE[step.status])}
        aria-hidden
      />
      <span className="min-w-0 leading-5">{label}</span>
    </li>
  );
}

function PlanModal(props: {
  readonly segment: PlanSegmentModel;
  readonly planActions: ChatPlanActionsContextValue | null;
  readonly markdownFallback: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly actionsVisible: boolean;
  readonly actionsDisabled: boolean;
  readonly onImplement: () => void;
}) {
  const { segment, planActions, markdownFallback, open } = props;
  const hasFullContent = segment.fullContentRef !== null;
  const planQuery = useAgentPlanQuery({
    epicId: planActions?.epicId ?? "",
    chatId: planActions?.chatId ?? "",
    planId: segment.planId,
    contentIdentity: segment.contentIdentity,
    enabled: open && hasFullContent && planActions !== null,
  });
  // The Dialog portals to <body>; re-assert the active theme on the modal so its
  // tokens (e.g. --primary-foreground for the Implement button) resolve to the
  // SAME values as the inline card, even if the portal escapes the themed root in
  // some shells.
  const { resolvedTheme, themePreset } = useResolvedTheme();
  const { markdown: modalMarkdown, unavailable } = resolvePlanModalContent(
    planQuery,
    markdownFallback,
  );
  const modalHeadline = planHeadline(segment, modalMarkdown);
  const modalBody = stripRedundantTitleHeading(modalMarkdown, modalHeadline);
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-theme={themePreset}
        style={{ colorScheme: resolvedTheme }}
        className={cn(
          resolvedTheme === "dark" ? "dark" : null,
          "grid max-h-[min(86dvh,calc(100dvh-2rem))] w-[min(92vw,72rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,72rem)]",
        )}
      >
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <PlanHarnessIcon harnessId={segment.harnessId} />
            <DialogTitle className="text-ui-lg">{modalHeadline}</DialogTitle>
            <PlanStatusBadge
              planStatus={segment.planStatus}
              isStreaming={segment.isStreaming}
            />
          </div>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {planQuery.isFetching ? (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-ui-sm text-muted-foreground">
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="plan-fetch-spinner"
                variant="dots"
              />
              Loading full plan
            </div>
          ) : null}
          {unavailable ? (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm text-amber-900 dark:text-amber-200">
              <FileWarning className="size-3.5 shrink-0" aria-hidden />
              Full plan content is unavailable. Showing the saved preview.
            </div>
          ) : null}
          <TraycerMarkdown
            className={null}
            proseSize="normal"
            components={null}
            remarkPlugins={null}
            rehypePlugins={null}
            isStreaming={false}
          >
            {modalBody}
          </TraycerMarkdown>
        </div>
        <DialogFooter className="sticky bottom-0 mx-0 mb-0 flex-col gap-2 rounded-none border-t border-border/40 bg-popover/95 px-5 py-3 backdrop-blur supports-backdrop-filter:bg-popover/80 sm:flex-row sm:items-center sm:justify-between">
          <PlanCopyButton markdown={modalMarkdown} />
          {props.actionsVisible ? (
            <PlanImplementButton
              onImplement={props.onImplement}
              disabled={props.actionsDisabled}
              compact={false}
            />
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function resolvePlanModalContent(
  planQuery: UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "agent.gui.getPlan">,
    HostRpcError
  >,
  markdownFallback: string,
): { readonly markdown: string; readonly unavailable: boolean } {
  if (
    planQuery.data !== undefined &&
    planQuery.data.unavailableReason === null
  ) {
    return { markdown: planQuery.data.markdown, unavailable: false };
  }
  const unavailable =
    planQuery.isError ||
    (planQuery.data !== undefined && planQuery.data.unavailableReason !== null);
  return { markdown: markdownFallback, unavailable };
}

function PlanHarnessIcon(props: { readonly harnessId: string }) {
  const parsed = guiHarnessIdSchema.safeParse(props.harnessId);
  if (parsed.success) {
    return <HarnessIcon harnessId={parsed.data} className="text-foreground" />;
  }
  return <Sparkles className="size-4 shrink-0 text-muted-foreground" />;
}

function PlanStatusBadge(props: {
  readonly planStatus: PlanSegmentModel["planStatus"];
  readonly isStreaming: boolean;
}) {
  // The awaiting-approval state is conveyed by the inline Implement/Reject
  // actions, so suppress its status badge to avoid a redundant label.
  if (props.planStatus === "awaiting_approval") return null;
  const Icon = STATUS_ICONS[props.planStatus];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-ui-xs",
        statusBadgeTone(props.planStatus),
      )}
    >
      <Icon
        className={cn(
          "size-3 shrink-0",
          props.isStreaming ? "animate-spin" : null,
        )}
        aria-hidden
      />
      <span className="truncate">{PLAN_STATUS_LABELS[props.planStatus]}</span>
    </span>
  );
}

function PlanActionButtons(props: {
  readonly onImplement: () => void;
  readonly onExpand: () => void;
  readonly disabled: boolean;
  readonly compact: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.onExpand}
      >
        <ExternalLink className="size-3.5" aria-hidden />
        Expand plan
      </Button>
      <PlanImplementButton
        onImplement={props.onImplement}
        disabled={props.disabled}
        compact={props.compact}
      />
    </div>
  );
}

function PlanImplementButton(props: {
  readonly onImplement: () => void;
  readonly disabled: boolean;
  readonly compact: boolean;
}) {
  return (
    <Button
      type="button"
      size={props.compact ? "sm" : "default"}
      variant="default"
      disabled={props.disabled}
      onClick={props.onImplement}
    >
      <Check className="size-3.5" aria-hidden />
      Implement
    </Button>
  );
}

function PlanCopyButton(props: { readonly markdown: string }) {
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });
  const handleCopy = useCallback(
    () => copy(props.markdown),
    [copy, props.markdown],
  );
  return (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function planCardTone(status: PlanSegmentModel["planStatus"]): string {
  if (status === "awaiting_approval") {
    return "border-primary/45 bg-primary/5";
  }
  if (status === "approved") {
    return "border-emerald-500/25 bg-emerald-500/5";
  }
  if (status === "rejected" || status === "superseded") {
    return "border-border/35 bg-muted/20 opacity-85";
  }
  return "border-border/45 bg-card";
}

function statusBadgeTone(status: PlanSegmentModel["planStatus"]): string {
  if (status === "awaiting_approval") {
    return "border-primary/35 bg-primary/10 text-primary";
  }
  if (status === "approved") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "rejected") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "superseded") {
    return "border-border/50 bg-muted/50 text-muted-foreground";
  }
  return "border-border/50 bg-muted/40 text-muted-foreground";
}

// Drop the leading markdown heading from the modal body ONLY when it duplicates
// the headline shown as the DialogTitle, so the title appears once, not twice.
function stripRedundantTitleHeading(
  markdown: string,
  headline: string,
): string {
  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].trim().length === 0) index += 1;
  if (index >= lines.length) return markdown;
  const heading = lines[index].trim().match(/^#{1,3}\s+(.*)$/);
  if (heading === null || heading[1].trim() !== headline.trim())
    return markdown;
  lines.splice(index, 1);
  if (index < lines.length && lines[index].trim().length === 0) {
    lines.splice(index, 1);
  }
  return lines.join("\n").trim();
}
