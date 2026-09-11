import { type Transition } from "motion/react";
import * as m from "motion/react-m";
import {
  useEpicDndStore,
  type HeaderTabDragGhost,
} from "@/components/epic-canvas/dnd/dnd-store";
import { cn } from "@/lib/utils";
import type { HeaderTab } from "@/stores/tabs/types";
import { HeaderTabPreview } from "./header-tab-visual";
import { headerTabClassName } from "./tab-chrome-tokens";

const HEADER_TAB_OVERLAY_TRANSITION = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.7,
} satisfies Transition;

interface HeaderTabDragOverlayProps {
  readonly tab: HeaderTab;
  /**
   * Render-ready enrichment (`appearance`, `indicatorState`)
   * resolved ONCE at drag start from the strip item's own drag payload - see
   * `HeaderTabDragGhost` in `dnd-store.ts` for why this exists and what it
   * deliberately does not keep live. `null` only when no header-tab drag is
   * active, or the payload came from a drag begun before a hot reload.
   */
  readonly ghost: HeaderTabDragGhost | null;
  /** Source tab's measured width, so the dragged object is the tab itself. */
  readonly width: number | null;
}

/** Captured appearance and notifications with live activity status. */
export function HeaderTabDragOverlay(props: HeaderTabDragOverlayProps) {
  const tab = props.tab;
  // While a merge target is highlighted the overlay ghosts: the highlight sits
  // on the approach half of the target tab, which is exactly where this
  // overlay is - opaque, it would cover the one signal the gesture shows.
  const mergeTargeted = useEpicDndStore(
    (state) => state.topLevelStripPairPreview !== null,
  );
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
      style={props.width === null ? undefined : { width: props.width }}
      className={cn(
        headerTabClassName("own", true),
        "pointer-events-none cursor-grabbing select-none",
      )}
    >
      <HeaderTabPreview tab={tab} ghost={props.ghost} chrome="own" isActive />
    </m.div>
  );
}
