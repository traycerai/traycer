import type { ReactNode } from "react";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
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
import {
  tabAppearance,
  type HeaderTab,
  type HeaderTabAppearance,
} from "@/stores/tabs/types";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTabDragGhost } from "@/components/epic-canvas/dnd/dnd-store";
import { TabLeadingIcon } from "./tab-leading-icon";

interface HeaderTabVisualProps {
  readonly tab: HeaderTab;
  readonly appearance: HeaderTabAppearance | null;
  readonly indicatorState: NotificationIndicatorState;
  readonly displayName: string;
  readonly chrome: "own" | "member";
  readonly isActive: boolean;
  readonly titleControl: ReactNode;
  readonly trailingControl: ReactNode;
  readonly leaderVisible: boolean;
}

/** Shared tab paint; activation, drag registration and controls belong to callers. */
export function HeaderTabVisual(props: HeaderTabVisualProps) {
  const epicId = props.tab.kind === "epic" ? props.tab.epicId : null;
  const titleGenerationPending = useRegisteredEpicTitleGenerating(epicId);
  const activityStatus = useEpicActivityStatus(epicId);
  const color = props.appearance?.color ?? null;
  return (
    <>
      {props.chrome === "own" ? (
        <TabChrome isActive={props.isActive} color={color} />
      ) : (
        <SplitMemberChrome focused={props.isActive} color={color} />
      )}
      <span className="relative z-20 flex min-w-0 flex-1 items-center justify-center gap-1.5 outline-none">
        <TabLeadingIcon
          icon={props.tab.icon}
          identity={props.appearance}
          titleGenerationPending={titleGenerationPending}
          activityStatus={activityStatus}
          indicatorState={props.indicatorState}
          tabId={props.tab.id}
        />
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
  readonly ghost: HeaderTabDragGhost | null;
  readonly chrome: "own" | "member";
  readonly isActive: boolean;
}) {
  const { displayName } = useHeaderTabTitle(props.tab);
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.tab.kind === "epic" ? props.tab.epicId : props.tab.id },
    null,
  );
  return (
    <HeaderTabVisual
      {...props}
      appearance={
        props.ghost === null ? tabAppearance(props.tab) : props.ghost.appearance
      }
      indicatorState={props.ghost?.indicatorState ?? indicatorState}
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
      <SplitMemberChrome focused={props.focused} color={null} />
      <span className="header-tab-title-text relative z-20 min-w-0 flex-1 text-left italic">
        {props.label}
      </span>
    </>
  );
}

export function TabChrome(props: {
  readonly isActive: boolean;
  readonly color: string | null;
}) {
  if (!props.isActive) {
    return (
      <>
        {props.color !== null ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
            style={{ backgroundColor: props.color }}
          />
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-2 inset-y-1 rounded-md bg-accent/45 opacity-0 transition-opacity duration-150 ease-out group-focus-visible/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100 group-hover/tab:opacity-100"
        />
      </>
    );
  }
  return (
    <TabChromeBackground
      fill="var(--color-background)"
      borderColor={props.color ?? "var(--color-border)"}
      coversBaseline
      className="transition-opacity duration-300 ease-spring"
    />
  );
}
