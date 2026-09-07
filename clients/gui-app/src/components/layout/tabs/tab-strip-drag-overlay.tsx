import { type Transition } from "motion/react";
import * as m from "motion/react-m";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { displayTitle } from "@/lib/display-title";
import type { HeaderTab, TabIcon } from "@/stores/tabs/types";

const HEADER_TAB_OVERLAY_TRANSITION = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.7,
} satisfies Transition;

interface HeaderTabDragOverlayProps {
  readonly tab: HeaderTab;
  readonly width: number | null;
}

export function HeaderTabDragOverlay(props: HeaderTabDragOverlayProps) {
  const { tab } = props;
  // While a merge target is highlighted the overlay ghosts.
  const mergeTargeted = useEpicDndStore(
    (state) => state.topLevelStripPairPreview !== null,
  );
  // Epic tabs can carry an empty name; render through `displayTitle`. Render
  // only - never mutate the tab.
  const displayName =
    tab.kind === "epic" ? displayTitle(tab.name, "epic") : tab.name;
  return (
    <m.div
      // Named so an instrument can find it by identity rather than by a heuristic.
      data-testid="header-tab-drag-overlay"
      // No entry scale/offset: the dragged tab must be the SAME object that was
      // under the pointer a frame ago, not a chip that animates into being.
      initial={false}
      animate={{ opacity: mergeTargeted ? 0.45 : 1 }}
      transition={HEADER_TAB_OVERLAY_TRANSITION}
      style={props.width === null ? undefined : { width: props.width }}
      className="pointer-events-none flex h-10 cursor-grabbing select-none items-center gap-2 rounded-t-md border border-b-0 border-border/80 bg-background px-[clamp(0.75rem,10%,1.5rem)] text-ui-sm font-medium text-foreground shadow-lg"
    >
      <TabLeadingIcon icon={tab.icon} />
      <span className="min-w-0 truncate">{displayName}</span>
    </m.div>
  );
}

function TabLeadingIcon(props: { readonly icon: TabIcon | null }) {
  if (props.icon === null) return null;
  const Icon = props.icon;
  return <Icon className="size-3.5 shrink-0" />;
}
