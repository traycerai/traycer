import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  HOST_PROGRESS_IDLE_HEADING,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";

/**
 * Poll cadence for the bootstrap.log tail while details are open. Tight
 * enough to feel live; only runs while the disclosure is expanded so the
 * CLI subprocess cost is paid only when the user is actively watching.
 */
const BOOTSTRAP_TAIL_POLL_MS = 1500;

export interface LocalHostLoadingContentProps {
  /**
   * The shared host-progress view (F19's one copy table), not a raw lane
   * event. Built by the caller so this body and Settings ▸ Host read the same
   * table: they used to phrase the same install two different ways, one keyed
   * on the progress stage and one on the mutation kind.
   */
  readonly progress: HostProgressView | null;
  readonly onConfigureShell: () => void;
}

/**
 * The host-boot body: spinner, progress heading/detail, the download progress
 * bar, and the bootstrap-log disclosure (with the "Configure shell…"
 * shortcut). Deliberately has no outer chrome (no `min-h-svh` wrapper, no
 * `<AppHeader>`, no `<Card>`) so its caller provides its own bounded layout.
 *
 * ONE PURPOSE, since P3.4: this describes a start that is still in progress,
 * and nothing else. It used to take a `stage` and grow a second face on
 * `"slow"` - its own "taking longer than expected" copy, its own Retry, and
 * the failed-attempt summary. Every caller of that arm is gone: the modal
 * (now the only caller) passes a start that is progressing and states its
 * actions in one row of its own, drawing the attempt diagnostics beside this
 * body on the arm where they are true. A body with no branch cannot disagree
 * with the surface it sits in about what is happening.
 */
export function LocalHostLoadingContent(
  props: LocalHostLoadingContentProps,
): ReactNode {
  const runnerHost = useRunnerHost();
  const hasCli = runnerHost.traycerCli !== null;
  const [showDetails, setShowDetails] = useState<boolean>(false);
  // Only poll while the disclosure is open. Cache stays warm if the user
  // toggles closed-then-open quickly.
  const status = useRunnerTraycerHostStatusQuery({
    pollIntervalMs: showDetails ? BOOTSTRAP_TAIL_POLL_MS : null,
  });
  const tail = status.data?.bootstrapLogTail ?? "";
  const progressView = props.progress;

  return (
    <>
      <AgentSpinningDots
        testId="local-host-loading-spinner"
        variant="pulse"
        className="h-8 min-w-8 text-title-md text-foreground"
      />
      <p className="text-ui font-medium text-foreground">
        {progressView?.heading ?? HOST_PROGRESS_IDLE_HEADING}
      </p>
      <ProgressLines view={progressView} />
      {hasCli ? (
        <DetailsDisclosure
          open={showDetails}
          onToggle={() => setShowDetails((v) => !v)}
          tail={tail}
          onConfigureShell={props.onConfigureShell}
        />
      ) : null}
    </>
  );
}

/**
 * The lane's detail line and its progress bar, both of which only exist when
 * the lane has said something. Split out of the body so the body's branch
 * count stays about its own layout rather than about the view's optionality.
 */
function ProgressLines(props: {
  readonly view: HostProgressView | null;
}): ReactNode {
  const { view } = props;
  if (view === null) return null;
  return (
    <>
      {view.detail === null ? null : (
        <p
          data-testid="local-host-loading-progress-detail"
          className="text-ui-sm text-muted-foreground"
        >
          {view.detail}
        </p>
      )}
      {view.percent === null ? null : (
        <HostDownloadProgress
          percent={view.percent}
          shortLabel={view.shortLabel}
          transferLabel={view.transferLabel}
        />
      )}
    </>
  );
}

interface HostDownloadProgressProps {
  readonly percent: number;
  readonly shortLabel: string;
  readonly transferLabel: string | null;
}

function HostDownloadProgress(props: HostDownloadProgressProps) {
  return (
    <div
      data-testid="local-host-download-progress"
      className="flex w-full flex-col gap-2"
    >
      <div className="flex items-center justify-between text-ui-xs text-muted-foreground">
        <span>{props.transferLabel ?? props.shortLabel}</span>
        <span className="font-medium text-foreground">{props.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.percent}
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/8"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${props.percent}%` }}
        />
      </div>
    </div>
  );
}

interface DetailsDisclosureProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tail: string;
  readonly onConfigureShell: () => void;
}

/**
 * Tucks the bootstrap.log tail and the "Configure shell…" affordance
 * behind a single text toggle. The default loading card stays clean
 * (spinner + heading + optional Retry); users only see logs and the
 * shell-settings shortcut when they explicitly ask.
 */
function DetailsDisclosure(props: DetailsDisclosureProps) {
  const Icon = props.open ? ChevronUp : ChevronDown;
  return (
    <div className="flex w-full flex-col items-stretch gap-3">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        data-testid="local-host-loading-toggle-details"
        className="inline-flex items-center justify-center gap-1 self-center text-ui-xs text-muted-foreground hover:text-foreground"
      >
        <span>{props.open ? "Hide details" : "Show details"}</span>
        <Icon className="size-3" />
      </button>
      {props.open ? (
        <>
          <BootstrapLogTail tail={props.tail} />
          <div className="flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={props.onConfigureShell}
              data-testid="local-host-open-shell-settings"
            >
              Configure shell…
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

interface BootstrapLogTailProps {
  readonly tail: string;
}

/**
 * Live tail of `~/.traycer/bootstrap.log`. Auto-scrolls to the bottom on
 * every refresh so the most recent line stays visible - same UX as a
 * `tail -f` in a terminal pane.
 */
function BootstrapLogTail(props: BootstrapLogTailProps) {
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [props.tail]);

  if (props.tail.length === 0) {
    return (
      <p
        data-testid="local-host-loading-empty-tail"
        // muted-fill-ok: weak tint delimited by its own border-border/60
        className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-center text-ui-xs text-muted-foreground"
      >
        Waiting for bootstrap output…
      </p>
    );
  }

  return (
    <pre
      ref={ref}
      data-testid="local-host-loading-log-tail"
      // muted-fill-ok: weak tint delimited by its own border-border/60
      className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground"
    >
      {props.tail}
    </pre>
  );
}
