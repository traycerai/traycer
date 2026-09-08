import { type Transition } from "motion/react";
import * as m from "motion/react-m";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { displayTitle } from "@/lib/display-title";
import type { HeaderTab } from "@/stores/tabs/types";
import { useHeaderTabAppearance } from "@/hooks/appearance/use-header-tab-appearance";
import { repositoryTabFill } from "./repository-identity-presentation";
import { TabLeadingIcon } from "./tab-leading-icon";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useRegisteredEpicTitleGenerating } from "@/lib/epic-selectors";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";

const HEADER_TAB_OVERLAY_TRANSITION = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.7,
} satisfies Transition;

interface HeaderTabDragOverlayProps {
  readonly tab: HeaderTab;
  /** Source tab's measured width, so the dragged object is the tab itself. */
  readonly width: number | null;
}

export function HeaderTabDragOverlay(props: HeaderTabDragOverlayProps) {
  const tab = useHeaderTabAppearance(props.tab) ?? props.tab;
  const epicId = tab.kind === "epic" ? tab.epicId : null;
  const activityStatus = useEpicActivityStatus(epicId);
  const titleGenerationPending = useRegisteredEpicTitleGenerating(epicId);
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds: epicId === null ? [] : [epicId],
    chatIds: [],
    enabled: epicId !== null,
  });
  // While a merge target is highlighted the overlay ghosts: the highlight sits
  // on the approach half of the target tab, which is exactly where this
  // overlay is - opaque, it would cover the one signal the gesture shows.
  const mergeTargeted = useEpicDndStore(
    (state) => state.topLevelStripPairPreview !== null,
  );
  // Epic tabs can carry an empty name; render through `displayTitle`. Render
  // only - never mutate the tab.
  const displayName =
    tab.kind === "epic" ? displayTitle(tab.name, "epic") : tab.name;
  return (
    <m.div
      // Named so an instrument can find it by identity rather than by a
      // heuristic. It was previously located as "the first `.cursor-grabbing`
      // element under 500px wide, excluding the shield" - which happened to be
      // correct and had no reason to stay so.
      data-testid="header-tab-drag-overlay"
      // No entry scale/offset: the dragged tab must be the SAME object that was
      // under the pointer a frame ago, not a chip that animates into being.
      initial={false}
      animate={{ opacity: mergeTargeted ? 0.45 : 1 }}
      transition={HEADER_TAB_OVERLAY_TRANSITION}
      style={{
        width: props.width ?? undefined,
        backgroundColor: repositoryTabFill(tab.repositoryIdentity?.color),
      }}
      className="pointer-events-none flex h-10 cursor-grabbing select-none items-center gap-2 rounded-t-md border border-b-0 border-border/80 bg-background px-[clamp(0.75rem,10%,1.5rem)] text-ui-sm font-medium text-foreground shadow-lg"
    >
      <NotificationIndicatorsProvider indicators={indicators}>
        <TabLeadingIcon
          icon={tab.icon}
          identity={tab.repositoryIdentity}
          titleGenerationPending={titleGenerationPending}
          activityStatus={activityStatus}
          tabId={tab.id}
          epicId={epicId}
        />
      </NotificationIndicatorsProvider>
      <span className="min-w-0 truncate">{displayName}</span>
    </m.div>
  );
}
