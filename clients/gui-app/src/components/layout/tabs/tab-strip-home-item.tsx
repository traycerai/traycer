import { type ReactNode } from "react";
import { House } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { TabChrome } from "@/components/layout/tabs/header-tab-visual";
import { headerTabClassName } from "@/components/layout/tabs/tab-chrome-tokens";
import { cn } from "@/lib/utils";

const HOME_TAB_LABEL = "Home";

interface TabStripHomeItemProps {
  readonly isActive: boolean;
  readonly onActivate: () => void;
}

/**
 * The fixed Home tab at the left edge of the strip.
 *
 * Deliberately not a `TabItem`: Home has no strip ref, so every affordance that
 * component carries - drag source, drop slot, context menu, close button,
 * `data-tab-index` digit badge - is one Home must not have. What it does share
 * is the silhouette, so it borrows `TabChrome` rather than growing a second set
 * of tab-shaped tokens - passing no colour, since a manual tab colour belongs
 * to a strip record and Home has none - and the same `headerTabClassName`
 * box the task tabs stand in, so the bubble is the same height and carries
 * the same horizontal padding as its neighbours. It used to be its own
 * `h-10 w-11` box, which read as a narrower, taller bubble beside the `h-9 …
 * px-6` tabs. Only the width rule differs: a task tab fills its motion frame
 * (`w-full`), while Home is icon-only and sizes to its padding. No
 * `data-tab-index` in particular: the Alt-digit chords index
 * `useHeaderTabs()`, which Home is not in, so `alt+1` still names the first
 * task tab. Nothing counts on it either: the header bell is the one attention
 * counter, and Home lists the prompts it points at.
 */
export function TabStripHomeItem(props: TabStripHomeItemProps): ReactNode {
  const { isActive, onActivate } = props;

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
        aria-label={HOME_TAB_LABEL}
        data-testid="tab-home"
        data-tab-kind="home"
        onClick={onActivate}
        // The task tabs' own box, then the two things an icon-only item does
        // differently: it sizes to its padding rather than filling a frame,
        // and it centres the one glyph it holds. `cn()` lets `w-auto` displace
        // the token's `w-full`.
        className={cn(
          headerTabClassName("own", isActive),
          "w-auto shrink-0 cursor-pointer justify-center [-webkit-app-region:no-drag]",
        )}
      >
        {/* No manual colour: Home is not a projected tab, so there is no
          record to carry an appearance and nothing in the menu to set one. */}
        <TabChrome isActive={isActive} color={null} />
        <House className="relative z-20 size-4" />
      </button>
    </TooltipWrapper>
  );
}
