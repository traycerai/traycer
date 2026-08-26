/**
 * The non-row states of a raw-terminal list - loading, load failure, empty,
 * and a durable create that failed - shared by the desktop left panel and the
 * phone switcher's Terminals category.
 *
 * These carry the surface's answers to "why is this list not showing me a
 * terminal", which is exactly where a re-implemented list drifts: a phone that
 * renders only rows shows "No terminals yet." while the query is still
 * pending, and again when it has failed outright, with no way back. Sharing
 * them means both surfaces say the same true thing, and the phone gets the
 * retry path too. Test ids differ per surface via `testIdPrefix`; the copy and
 * the actions do not.
 */
import { Terminal as TerminalIcon } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import {
  discardEpicTerminalDurableCreate,
  retryEpicTerminalDurableCreate,
  type EpicTerminalDurableCreateJobView,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { epicTerminalUiIdentityKey } from "@/lib/terminals/pending-create-identity";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export function TerminalsLoadingState(props: {
  readonly testIdPrefix: string;
}) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground"
      data-testid={`${props.testIdPrefix}-loading`}
    >
      <AgentSpinningDots
        className="shrink-0 text-muted-foreground/70"
        testId={undefined}
        variant={undefined}
      />
      <span>Loading terminals…</span>
    </div>
  );
}

export function TerminalsErrorState(props: {
  readonly message: string | null;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
  readonly testIdPrefix: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 px-2 py-1.5 text-ui-sm text-destructive"
      data-testid={`${props.testIdPrefix}-error`}
    >
      <span className="min-w-0">
        {props.message ?? "Failed to load terminals."}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.isRetrying}
          data-testid={`${props.testIdPrefix}-retry`}
          onClick={props.onRetry}
        >
          {props.isRetrying ? (
            <AgentSpinningDots
              className="shrink-0"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Retry
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Failed to load terminals",
            message: "The terminal list could not be loaded.",
            code: null,
            source: "Terminals",
          })}
          presentation="icon"
          className="text-current"
        />
      </div>
    </div>
  );
}

export function TerminalsEmptyState(props: { readonly testIdPrefix: string }) {
  return (
    <SidebarPanelEmptyState
      icon={TerminalIcon}
      title="No terminals yet."
      description={null}
      testId={`${props.testIdPrefix}-empty`}
    />
  );
}

/**
 * A durable create that failed and has no authoritative row to stand for it.
 * Offers the two ways out - try again, or forget it - so a failed launch is
 * never a silently missing terminal.
 */
export function FailedTerminalCreateRow(props: {
  readonly job: EpicTerminalDurableCreateJobView;
  readonly testIdPrefix: string;
}) {
  const { job, testIdPrefix } = props;
  const unmarkPendingCreate = useEpicCanvasStore(
    (state) => state.unmarkTerminalPendingCreate,
  );
  const title = DEFAULT_TERMINAL_TITLE;
  const message = job.error?.message ?? "Could not create terminal.";
  const identityKey = epicTerminalUiIdentityKey(
    "failed",
    job.request.hostId,
    job.request.terminalId,
  );
  return (
    <div
      className="rounded-md px-2 py-1.5"
      data-testid={`${testIdPrefix}-failed-create-${identityKey}`}
    >
      <div className="flex min-w-0 items-start gap-1.5 text-ui-sm">
        <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground/80">{title}</div>
          <div className="truncate text-destructive">{message}</div>
          <div className="mt-1 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`${testIdPrefix}-failed-retry-${identityKey}`}
              onClick={() => {
                retryEpicTerminalDurableCreate(
                  job.request.hostId,
                  job.request.terminalId,
                );
              }}
            >
              Retry
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`${testIdPrefix}-failed-discard-${identityKey}`}
              onClick={() => {
                discardEpicTerminalDurableCreate(
                  job.request.hostId,
                  job.request.terminalId,
                );
                unmarkPendingCreate(job.request.hostId, job.request.terminalId);
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
