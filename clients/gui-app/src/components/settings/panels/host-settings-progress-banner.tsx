import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  formatProgressKind,
  formatTransfer,
  type HostProgressState,
} from "@/components/settings/panels/host-settings-panel-model";

interface HostProgressBannerProps {
  readonly progress: HostProgressState;
}

export function HostProgressBanner(props: HostProgressBannerProps) {
  const { kind, progress } = props.progress;
  const percent =
    progress !== null && progress.percent !== null
      ? Math.max(0, Math.min(100, Math.round(progress.percent)))
      : null;
  const transferLabel =
    progress !== null
      ? formatTransfer(progress.bytes, progress.totalBytes)
      : null;
  return (
    <output
      className="flex flex-col gap-2 border-b border-border/40 bg-muted/30 px-5 py-3 text-ui-sm"
      data-testid="settings-host-progress"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <AgentSpinningDots
            className="size-3 shrink-0"
            testId={undefined}
            variant={undefined}
          />
          <span className="font-medium text-foreground">
            {formatProgressKind(kind)}
          </span>
          {progress?.stage !== null && progress?.stage !== undefined ? (
            <span className="font-mono text-code-xs text-muted-foreground">
              {progress.stage}
            </span>
          ) : null}
        </div>
        <ProgressLabel percent={percent} transferLabel={transferLabel} />
      </div>
      {percent !== null ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-emerald-500 transition-[width] duration-150"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {progress?.message !== null && progress?.message !== undefined ? (
        <div className="truncate text-ui-xs text-muted-foreground">
          {progress.message}
        </div>
      ) : null}
    </output>
  );
}

function ProgressLabel(props: {
  readonly percent: number | null;
  readonly transferLabel: string | null;
}) {
  const { percent, transferLabel } = props;
  if (percent !== null) {
    return (
      <span
        className="font-mono text-code-xs tabular-nums text-muted-foreground"
        data-testid="settings-host-progress-percent"
      >
        {percent}%
      </span>
    );
  }
  if (transferLabel !== null) {
    return (
      <span
        className="font-mono text-code-xs tabular-nums text-muted-foreground"
        data-testid="settings-host-progress-bytes"
      >
        {transferLabel}
      </span>
    );
  }
  return null;
}
