import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { MutationProgress } from "@traycer-clients/shared/platform/runner-host";
import { AppHeader } from "@/components/layout/header/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerTraycerHostStatusQuery } from "@/hooks/runner/use-runner-traycer-host-status-query";

export type LocalHostLoadingStage = "loading" | "slow";

export interface LocalHostLoadingProps {
  readonly stage: LocalHostLoadingStage;
  readonly progress: MutationProgress | null;
  /**
   * Called when the user clicks "Configure shell…". The caller drives
   * router navigation directly because the loading card is rendered
   * alongside the (unmounted) RouterProvider, so `<Link>` would not have
   * router context. Once navigation completes, the gate observes the
   * `/settings/shell` path and unmounts this card in favour of children.
   */
  readonly onConfigureShell: () => void;
}

/**
 * Poll cadence for the bootstrap.log tail while details are open. Tight
 * enough to feel live; only runs while the disclosure is expanded so the
 * CLI subprocess cost is paid only when the user is actively watching.
 */
const BOOTSTRAP_TAIL_POLL_MS = 1500;

export function LocalHostLoading(props: LocalHostLoadingProps) {
  const respawn = useRunnerRequestHostRespawn();
  const runnerHost = useRunnerHost();
  const hasCli = runnerHost.traycerCli !== null;
  const [showDetails, setShowDetails] = useState<boolean>(false);
  // Only poll while the disclosure is open. Cache stays warm if the user
  // toggles closed-then-open quickly.
  const status = useRunnerTraycerHostStatusQuery({
    pollIntervalMs: showDetails ? BOOTSTRAP_TAIL_POLL_MS : null,
  });
  const tail = status.data?.bootstrapLogTail ?? "";
  const progressView = buildProgressView(props.progress);

  return (
    <div
      data-testid="local-host-loading"
      data-stage={props.stage}
      className="flex min-h-svh w-full flex-col bg-background text-foreground"
    >
      <AppHeader variant="host-loading" />
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardContent className="flex flex-col items-center gap-4 py-6 text-center text-ui-sm">
            <AgentSpinningDots
              testId="local-host-loading-spinner"
              variant="pulse"
              className="h-8 min-w-8 text-title-md text-foreground"
            />
            <p className="text-ui font-medium text-foreground">
              {progressView.heading}
            </p>
            {progressView.detail !== null ? (
              <p
                data-testid="local-host-loading-progress-detail"
                className="text-ui-sm text-muted-foreground"
              >
                {progressView.detail}
              </p>
            ) : null}
            {progressView.percent !== null ? (
              <HostDownloadProgress
                percent={progressView.percent}
                stage={progressView.stage}
                byteLabel={progressView.byteLabel}
              />
            ) : null}
            {props.stage === "slow" ? (
              <div
                data-testid="local-host-loading-slow-copy"
                className="flex flex-col items-center gap-3"
              >
                <p className="text-ui-sm text-muted-foreground">
                  Local host is taking longer than expected.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={respawn.isPending}
                  onClick={() => {
                    respawn.mutate();
                  }}
                  data-testid="local-host-retry"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span>Retry</span>
                    {respawn.isPending ? (
                      <AgentSpinningDots
                        className={undefined}
                        testId="local-host-retry-spinner"
                        variant={undefined}
                      />
                    ) : null}
                  </span>
                </Button>
              </div>
            ) : null}
            {hasCli ? (
              <DetailsDisclosure
                open={showDetails}
                onToggle={() => setShowDetails((v) => !v)}
                tail={tail}
                onConfigureShell={props.onConfigureShell}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface ProgressView {
  readonly heading: string;
  readonly detail: string | null;
  readonly stage: string | null;
  readonly percent: number | null;
  readonly byteLabel: string | null;
}

function buildProgressView(progress: MutationProgress | null): ProgressView {
  if (progress === null) {
    return {
      heading: "Starting local Traycer Host…",
      detail: null,
      stage: null,
      percent: null,
      byteLabel: null,
    };
  }
  const percent =
    progress.percent === null
      ? null
      : Math.min(100, Math.max(0, Math.round(progress.percent)));
  return {
    heading:
      progress.stage === "download"
        ? "Downloading Traycer Host…"
        : "Setting up Traycer Host…",
    detail: progress.message,
    stage: progress.stage,
    percent,
    byteLabel:
      progress.bytes !== null && progress.totalBytes !== null
        ? `${formatBytes(progress.bytes)} of ${formatBytes(progress.totalBytes)}`
        : null,
  };
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 10) return `${Math.round(mib)} MB`;
  return `${mib.toFixed(1)} MB`;
}

interface HostDownloadProgressProps {
  readonly percent: number;
  readonly stage: string | null;
  readonly byteLabel: string | null;
}

function HostDownloadProgress(props: HostDownloadProgressProps) {
  const fallbackLabel =
    props.stage === "download" ? "Downloading…" : "Setting up…";
  return (
    <div
      data-testid="local-host-download-progress"
      className="flex w-full flex-col gap-2"
    >
      <div className="flex items-center justify-between text-ui-xs text-muted-foreground">
        <span>{props.byteLabel ?? fallbackLabel}</span>
        <span className="font-medium text-foreground">{props.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.percent}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
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
      className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground"
    >
      {props.tail}
    </pre>
  );
}
