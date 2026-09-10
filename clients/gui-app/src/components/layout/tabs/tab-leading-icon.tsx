import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { EpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import type { HeaderTabRepositoryIdentity, TabIcon } from "@/stores/tabs/types";
import { RepositoryIdentityIcon } from "./repository-identity";

function hasResolvedIcon(
  identity: HeaderTabRepositoryIdentity,
): identity is HeaderTabRepositoryIdentity & {
  readonly icon: NonNullable<HeaderTabRepositoryIdentity["icon"]>;
} {
  return identity.icon !== null;
}

/**
 * Takes `indicatorState` as a resolved prop rather than reading
 * `NotificationIndicatorsContext` itself - both callers (the strip's
 * `TabItem` and the drag ghost's `HeaderTabDragOverlay`) already have it
 * resolved by the time they render this, and the drag ghost in particular
 * cannot reach that context at all (it renders in a sibling subtree of the
 * strip - see `tab-strip-drag-overlay.tsx`).
 */
export function TabLeadingIcon(props: {
  readonly icon: TabIcon | null;
  readonly identity: HeaderTabRepositoryIdentity | null;
  readonly titleGenerationPending: boolean;
  readonly activityStatus: EpicActivityStatus;
  readonly indicatorState: NotificationIndicatorState;
  readonly tabId: string;
}) {
  const identity = props.identity;
  let defaultIcon: React.ReactNode = null;
  if (props.titleGenerationPending) {
    defaultIcon = (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`header-tab-title-generating-${props.tabId}`}
        variant="dots2"
      />
    );
  } else if (props.icon !== null && (identity?.icon ?? null) === null) {
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
      {identity !== null && hasResolvedIcon(identity) ? (
        <span
          data-slot="tab-repository-icon"
          className="inline-flex size-5 shrink-0 items-center justify-center"
        >
          <RepositoryIdentityIcon
            identity={identity}
            fallbackIcon={props.icon}
          />
        </span>
      ) : null}
    </span>
  );
}
