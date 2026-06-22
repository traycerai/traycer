import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { LivePulse } from "@/components/ui/live-pulse";
import { useEpicConnectionStatus } from "@/lib/epic-selectors";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/**
 * Small inline connection-status pill that the active Epic header renders
 * so users can tell at a glance whether the per-Epic stream is connected,
 * reconnecting, or closed.
 *
 * Transient disconnects keep edits buffered in the per-Epic store and flush
 * on reconnect; the pill is the only indicator - there is no banner during
 * reconnect. See T6 scope for the decision.
 */
export function EpicConnectionPill() {
  const status = useEpicConnectionStatus();
  const indicator = indicatorFor(status);

  return (
    <TooltipWrapper
      label={indicator.tooltip}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        data-testid="epic-connection-pill"
        data-status={status}
        aria-label={indicator.ariaLabel}
        className={cn(
          "inline-flex items-center gap-1 text-ui-xs font-medium text-current focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          indicator.containerClassName,
        )}
      >
        <ConnectionPillDot indicator={indicator} />
        {indicator.label}
      </button>
    </TooltipWrapper>
  );
}

interface PillIndicator {
  readonly containerClassName: string;
  readonly dotClassName: string;
  readonly label: string | null;
  readonly showAgentSpinner: boolean;
  readonly pulse: "active" | "idle" | null;
  readonly tooltip: string | null;
  readonly ariaLabel: string;
}

function ConnectionPillDot(props: { indicator: PillIndicator }) {
  const { indicator } = props;
  if (indicator.showAgentSpinner) {
    return (
      <AgentSpinningDots
        testId="epic-connection-pill-dot"
        variant="dots"
        className={indicator.dotClassName}
      />
    );
  }
  if (indicator.pulse !== null) {
    return (
      <LivePulse
        size="xs"
        tone={indicator.pulse}
        ariaLabel={indicator.ariaLabel}
        className={cn("shrink-0", indicator.dotClassName)}
      />
    );
  }
  return (
    <span
      data-testid="epic-connection-pill-dot"
      className={cn("size-1.5 rounded-full", indicator.dotClassName)}
      aria-hidden
    />
  );
}

function indicatorFor(status: StreamConnectionStatus): PillIndicator {
  switch (status) {
    case "open":
      return {
        containerClassName:
          "h-5 px-1.5 py-0 text-overline italic leading-none text-muted-foreground",
        dotClassName: "",
        label: "All changes synced",
        showAgentSpinner: false,
        pulse: "active",
        tooltip: null,
        ariaLabel: "All changes synced",
      };
    case "connecting":
      return {
        containerClassName:
          "rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400",
        dotClassName: "text-amber-500",
        label: "Connecting…",
        showAgentSpinner: true,
        pulse: null,
        tooltip: null,
        ariaLabel: "Connecting to server",
      };
    case "reconnecting":
      return {
        containerClassName:
          "rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400",
        dotClassName: "text-amber-500",
        label: "Reconnecting…",
        showAgentSpinner: true,
        pulse: null,
        tooltip: null,
        ariaLabel: "Reconnecting to server",
      };
    case "closed":
      return {
        containerClassName:
          "rounded-md bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-400",
        dotClassName: "bg-red-500",
        label: "Offline",
        showAgentSpinner: false,
        pulse: null,
        tooltip: "Disconnected. Changes will sync when reconnected.",
        ariaLabel: "Disconnected. Changes will sync when reconnected.",
      };
  }
}
