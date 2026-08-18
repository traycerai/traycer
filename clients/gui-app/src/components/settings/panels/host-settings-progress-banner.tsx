import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { buildHostProgressView } from "@/lib/host/host-progress-copy";
import type { HostProgressState } from "@/components/settings/panels/host-settings-panel-model";

interface HostProgressBannerProps {
  readonly progress: HostProgressState;
}

/**
 * Settings' live host-mutation banner.
 *
 * Reads the SAME copy table as the window narrator (F19). These two surfaces
 * used to phrase one install two ways - "Setting up host" here against
 * "Setting up Traycer Host…" there, MiB here against MB there - so watching a
 * download from Settings and from the boot surface showed different words and
 * different sizes for the same bytes.
 */
export function HostProgressBanner(props: HostProgressBannerProps) {
  const view = buildHostProgressView(props.progress);
  if (view === null) return null;
  const { percent, transferLabel } = view;
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
          <span className="font-medium text-foreground">{view.heading}</span>
          {/* The raw stage token stays beside the sentence: it is the
              diagnostic line, and the heading only names the phase. */}
          {view.stage === null ? null : (
            <span className="font-mono text-code-xs text-muted-foreground">
              {view.stage}
            </span>
          )}
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
      {view.detail === null ? null : (
        <div className="truncate text-ui-xs text-muted-foreground">
          {view.detail}
        </div>
      )}
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
