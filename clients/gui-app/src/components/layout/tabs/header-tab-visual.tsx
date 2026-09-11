import type { ReactNode } from "react";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useRegisteredEpicTitleGenerating } from "@/lib/epic-selectors";
import { SplitMemberChrome } from "./split-tab-chrome";
import { TabChromeBackground } from "./tab-chrome-background";
import { useHeaderTabTitle } from "./header-tab-presentation";
import type { HeaderTab } from "@/stores/tabs/types";

interface HeaderTabVisualProps {
  readonly tab: HeaderTab;
  readonly displayName: string;
  readonly chrome: "own" | "member";
  readonly isActive: boolean;
  readonly titleControl: ReactNode;
  readonly trailingControl: ReactNode;
  readonly leaderVisible: boolean;
}

/** Shared tab paint; activation, drag registration and controls belong to callers. */
export function HeaderTabVisual(props: HeaderTabVisualProps) {
  return (
    <>
      {props.chrome === "own" ? (
        <TabChrome isActive={props.isActive} />
      ) : (
        <SplitMemberChrome focused={props.isActive} />
      )}
      <span className="relative z-20 flex min-w-0 flex-1 items-center justify-center gap-1.5 outline-none">
        <TabLeadingIcon tab={props.tab} />
        {props.titleControl ?? (
          <span
            className="header-tab-label relative flex min-w-0 flex-1 items-center gap-1.5 text-left"
            data-leader-visible={props.leaderVisible}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block min-w-0 flex-1">
                  <span
                    data-testid={`tab-title-${props.tab.kind}-${props.tab.id}`}
                    className="header-tab-title block"
                  >
                    <span className="header-tab-title-text">
                      {props.displayName}
                    </span>
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{props.displayName}</TooltipContent>
            </Tooltip>
            {props.trailingControl}
          </span>
        )}
      </span>
    </>
  );
}

export function HeaderTabPreview(props: {
  readonly tab: HeaderTab;
  readonly chrome: "own" | "member";
  readonly isActive: boolean;
}) {
  const { displayName } = useHeaderTabTitle(props.tab);
  return (
    <HeaderTabVisual
      {...props}
      displayName={displayName}
      titleControl={null}
      trailingControl={null}
      leaderVisible={false}
    />
  );
}

export function SplitFillableMemberVisual(props: {
  readonly label: string;
  readonly focused: boolean;
}) {
  return (
    <>
      <SplitMemberChrome focused={props.focused} />
      <span className="header-tab-title-text relative z-20 min-w-0 flex-1 text-left italic">
        {props.label}
      </span>
    </>
  );
}

function TabLeadingIcon(props: { readonly tab: HeaderTab }) {
  const { tab } = props;
  const epicId = tab.kind === "epic" ? tab.epicId : null;
  const titleGenerationPending = useRegisteredEpicTitleGenerating(epicId);
  const activityStatus = useEpicActivityStatus(epicId);
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: epicId ?? tab.id },
    null,
  );
  let defaultIcon: ReactNode = null;
  if (titleGenerationPending) {
    defaultIcon = (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`header-tab-title-generating-${tab.id}`}
        variant="dots2"
      />
    );
  } else if (tab.icon !== null) {
    const Icon = tab.icon;
    defaultIcon = <Icon className="size-3.5 shrink-0" />;
  }
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={activityStatus === "idle" ? false : activityStatus}
      activityCoverage="indeterminate"
      subjectId={tab.id}
      testIdPrefix="header-tab"
      className="text-muted-foreground"
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={defaultIcon}
      statusPresentation="message"
      agentSurface="gui"
    />
  );
}

function TabChrome(props: { readonly isActive: boolean }) {
  if (!props.isActive) {
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-2 inset-y-1 rounded-md bg-accent/45 opacity-0 transition-opacity duration-150 ease-out group-focus-visible/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100 group-hover/tab:opacity-100"
      />
    );
  }
  return (
    <TabChromeBackground
      fill="var(--color-background)"
      borderColor="var(--color-border)"
      coversBaseline
      className="transition-opacity duration-300 ease-spring"
    />
  );
}
