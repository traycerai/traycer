import { type Transition } from "motion/react";
import * as m from "motion/react-m";
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
}

export function HeaderTabDragOverlay(props: HeaderTabDragOverlayProps) {
  const { tab } = props;
  // Epic tabs can carry an empty name; render through `displayTitle`. Render
  // only - never mutate the tab.
  const displayName =
    tab.kind === "epic" ? displayTitle(tab.name, "epic") : tab.name;
  return (
    <m.div
      initial={{ opacity: 0, scale: 0.96, y: 2 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 2 }}
      transition={HEADER_TAB_OVERLAY_TRANSITION}
      className="pointer-events-none flex h-10 max-w-56 cursor-grabbing select-none items-center gap-2 rounded-md border border-border/80 bg-background px-3 text-ui-sm font-medium text-foreground shadow-lg"
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
