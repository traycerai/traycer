import { type Transition } from "motion/react";
import * as m from "motion/react-m";
import {
  useEpicDndStore,
  type HeaderTabDragGhost,
} from "@/components/epic-canvas/dnd/dnd-store";
import { displayTitle } from "@/lib/display-title";
import type { HeaderTab } from "@/stores/tabs/types";
import { EMPTY_NOTIFICATION_INDICATOR_STATE } from "@/stores/notifications/notification-indicator-state";
import { repositoryTabFill } from "./repository-identity-presentation";
import { TabLeadingIcon } from "./tab-leading-icon";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useRegisteredEpicTitleGenerating } from "@/lib/epic-selectors";

const HEADER_TAB_OVERLAY_TRANSITION = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.7,
} satisfies Transition;

interface HeaderTabDragOverlayProps {
  /**
   * The UNRESOLVED base tab (name/icon/route/id) - `useHeaderTabForRef`'s
   * projection, resolved via the strip's ordinary source-store subscription.
   * Carries no `repositoryIdentity` of its own; that comes from `ghost`.
   */
  readonly tab: HeaderTab;
  /**
   * Render-ready enrichment (`repositoryIdentity`, `indicatorState`)
   * resolved ONCE at drag start from the strip item's own drag payload - see
   * `HeaderTabDragGhost` in `dnd-store.ts` for why this exists and what it
   * deliberately does not keep live. `null` only when no header-tab drag is
   * active, or the payload came from a drag begun before a hot reload.
   */
  readonly ghost: HeaderTabDragGhost | null;
  /** Source tab's measured width, so the dragged object is the tab itself. */
  readonly width: number | null;
}

/**
 * The drag ghost of a header tab, rendered a few pixels from the tab it
 * mirrors. `repositoryIdentity` and the notification badge state ride
 * `props.ghost` - resolved once by the strip item at drag start, not
 * re-derived here - so mounting this overlay opens no `workspace.getAppearance`
 * host RPC and no notifications query. Activity status and title-generation
 * stay LIVE, via their own free `useSyncExternalStore` hooks, since neither
 * costs a round trip and both can genuinely change mid-drag.
 */
export function HeaderTabDragOverlay(props: HeaderTabDragOverlayProps) {
  const tab = props.tab;
  const epicId = tab.kind === "epic" ? tab.epicId : null;
  const activityStatus = useEpicActivityStatus(epicId);
  const titleGenerationPending = useRegisteredEpicTitleGenerating(epicId);
  const repositoryIdentity = props.ghost?.repositoryIdentity ?? null;
  const indicatorState =
    props.ghost?.indicatorState ?? EMPTY_NOTIFICATION_INDICATOR_STATE;
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
        backgroundColor: repositoryTabFill(repositoryIdentity?.color),
      }}
      className="pointer-events-none flex h-10 cursor-grabbing select-none items-center gap-2 rounded-t-md border border-b-0 border-border/80 bg-background px-[clamp(0.75rem,10%,1.5rem)] text-ui-sm font-medium text-foreground shadow-lg"
    >
      <TabLeadingIcon
        icon={tab.icon}
        identity={repositoryIdentity}
        titleGenerationPending={titleGenerationPending}
        activityStatus={activityStatus}
        indicatorState={indicatorState}
        tabId={tab.id}
      />
      <span className="min-w-0 truncate">{displayName}</span>
    </m.div>
  );
}
