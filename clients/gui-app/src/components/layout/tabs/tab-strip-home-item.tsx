import { type ReactNode } from "react";
import { House } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TabChrome } from "@/components/layout/tabs/tab-strip-item";
import { cn } from "@/lib/utils";

const HOME_TAB_LABEL = "Home";
const MAX_BADGE_COUNT = 99;

interface TabStripHomeItemProps {
  readonly isActive: boolean;
  readonly onActivate: () => void;
  /** Unresolved prompts waiting on the user; `0` renders no badge. */
  readonly badgeCount: number;
}

/**
 * The fixed Home tab at the left edge of the strip.
 *
 * Deliberately not a `TabItem`: Home has no strip ref, so every affordance that
 * component carries - drag source, drop slot, context menu, close button,
 * `data-tab-index` digit badge - is one Home must not have. What it does share
 * is the silhouette, so it borrows `TabChrome` rather than growing a second set
 * of tab-shaped tokens. No `data-tab-index` in particular: the Alt-digit chords
 * index `useHeaderTabs()`, which Home is not in, so `alt+1` still names the
 * first task tab.
 */
export function TabStripHomeItem(props: TabStripHomeItemProps): ReactNode {
  const { isActive, onActivate, badgeCount } = props;

  return (
    <TooltipWrapper
      label={HOME_TAB_LABEL}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        // The count rides the button's own label: an `aria-label` replaces the
        // element's whole subtree for assistive tech, so a label on the badge
        // itself would never be announced. Plain "Home" whenever there is
        // nothing waiting, which is the resting state.
        aria-label={homeAccessibleLabel(badgeCount)}
        data-testid="tab-home"
        data-tab-kind="home"
        onClick={onActivate}
        className={cn(
          "group/tab relative flex h-10 w-11 shrink-0 cursor-pointer items-center justify-center transition-colors duration-300 ease-spring [-webkit-app-region:no-drag]",
          isActive
            ? "z-10 text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <TabChrome isActive={isActive} />
        <House className="relative z-20 size-4" />
        <HomeBadge count={badgeCount} />
      </button>
    </TooltipWrapper>
  );
}

/**
 * How many prompts are waiting on the user, across every task. Absent at zero:
 * a badge reading "0" is a permanent decoration, not a signal.
 */
function HomeBadge(props: { readonly count: number }): ReactNode {
  if (props.count <= 0) return null;
  return (
    // Same badge the notifications bell wears, and for the same reason: both
    // count things waiting on the user, so they should not read as two
    // different signals. Only the offsets differ - the bell hangs its badge
    // outside a free-standing icon button, while this one has to stay inside
    // the tab's own silhouette.
    <span
      aria-hidden
      data-testid="tab-home-badge"
      className="absolute right-1 top-1 z-20 flex h-4 min-w-4 items-center justify-center rounded-md bg-destructive px-1 text-overline font-semibold leading-none text-destructive-foreground tabular-nums shadow-sm ring-2 ring-background"
    >
      {badgeLabel(props.count)}
    </span>
  );
}

function badgeLabel(count: number): string {
  return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count);
}

function homeAccessibleLabel(count: number): string {
  return count > 0
    ? `${HOME_TAB_LABEL}, ${badgeLabel(count)} waiting on you`
    : HOME_TAB_LABEL;
}
