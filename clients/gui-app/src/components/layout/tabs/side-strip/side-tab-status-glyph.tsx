import type { ReactNode } from "react";
import type { EpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { TabLeadingIcon } from "../tab-leading-icon";

/**
 * The shared indicator glyph of a task (running, background, pending fork,
 * done, terminal failure, or the spinner while its title generates), and
 * nothing at all when the task is idle: it collapses, so an idle active row
 * keeps no gap before its close.
 */
export function SideTabStatusGlyph(props: {
  readonly tabId: string;
  readonly indicatorState: NotificationIndicatorState;
  readonly activityStatus: EpicActivityStatus;
  readonly titleGenerating: boolean;
}): ReactNode {
  return (
    <span className="flex has-[[data-slot=tab-status-icon]:empty]:hidden">
      <TabLeadingIcon
        icon={null}
        identity={null}
        titleGenerationPending={props.titleGenerating}
        activityStatus={props.activityStatus}
        indicatorState={props.indicatorState}
        tabId={props.tabId}
      />
    </span>
  );
}
