import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { EpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import type { HeaderTabAppearance, TabIcon } from "@/stores/tabs/types";
import { cn } from "@/lib/utils";

const iconSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Paints custom identity beside the resolved activity and notification state. */
export function TabLeadingIcon(props: {
  readonly icon: TabIcon | null;
  readonly identity: HeaderTabAppearance | null;
  readonly titleGenerationPending: boolean;
  readonly activityStatus: EpicActivityStatus;
  readonly indicatorState: NotificationIndicatorState;
  readonly tabId: string;
}) {
  const identity = props.identity;
  const iconCharacters = Array.from(
    iconSegmenter.segment(identity?.icon?.trim() ?? ""),
  ).slice(0, 2);
  let defaultIcon: React.ReactNode = null;
  if (props.titleGenerationPending) {
    defaultIcon = (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`header-tab-title-generating-${props.tabId}`}
        variant="dots2"
      />
    );
  } else if (props.icon !== null && iconCharacters.length === 0) {
    const Icon = props.icon;
    defaultIcon = <Icon className="size-3.5 shrink-0" />;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span
        data-slot="tab-status-icon"
        className="inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <NotificationIndicatorIcon
          state={props.indicatorState}
          running={
            props.activityStatus === "idle" ? false : props.activityStatus
          }
          // An EPIC-level rollup over however many machines its agents sit on,
          // so there is no single host whose coverage could be asked about. The
          // per-agent rows inside the epic are where an unserved plane is
          // reported.
          activityCoverage="indeterminate"
          subjectId={props.tabId}
          testIdPrefix="header-tab"
          className="text-muted-foreground"
          style={undefined}
          runningTitle="Task activity in progress"
          defaultIcon={defaultIcon}
          statusPresentation="message"
          agentSurface="gui"
        />
      </span>
      {iconCharacters.length > 0 ? (
        <span
          data-slot="tab-custom-icon"
          className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden"
        >
          <span
            aria-hidden="true"
            className={cn(
              "whitespace-nowrap leading-none",
              iconCharacters.length === 1
                ? "text-base"
                : "text-micro font-medium",
            )}
          >
            {iconCharacters.map(({ segment }) => segment).join("")}
          </span>
        </span>
      ) : null}
    </span>
  );
}
