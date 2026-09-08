import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import type { EpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import type { HeaderTabRepositoryIdentity, TabIcon } from "@/stores/tabs/types";
import { RepositoryIdentityIcon } from "./repository-identity";

export function TabLeadingIcon(props: {
  readonly icon: TabIcon | null;
  readonly identity?: HeaderTabRepositoryIdentity;
  readonly titleGenerationPending: boolean;
  readonly activityStatus: EpicActivityStatus;
  readonly tabId: string;
  readonly epicId: string | null;
}) {
  const identity = props.identity ?? null;
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.epicId ?? props.tabId },
    null,
  );
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
    <>
      {identity !== null ? (
        <RepositoryIdentityIcon identity={identity} fallbackIcon={props.icon} />
      ) : null}
      <NotificationIndicatorIcon
        state={indicatorState}
        running={props.activityStatus === "idle" ? false : props.activityStatus}
        subjectId={props.tabId}
        testIdPrefix="header-tab"
        className="text-muted-foreground"
        style={undefined}
        runningTitle="Task activity in progress"
        defaultIcon={defaultIcon}
        statusPresentation="message"
        agentSurface="gui"
      />
    </>
  );
}
