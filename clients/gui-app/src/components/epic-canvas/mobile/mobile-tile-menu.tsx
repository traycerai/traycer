import { useCallback, useMemo, useState, type ReactNode } from "react";
import { TileSwitcherList } from "@/components/epic-canvas/mobile/tile-switcher-list";
import { MobileLevel2MenuContent } from "@/components/layout/shell/mobile-level2";
import { Popover } from "@/components/ui/popover";
import type { MobileTileSlot } from "@/lib/canvas/tile-open/intent";
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import {
  useIsMobileSwitcherOpen,
  useMobileSwitcherStore,
} from "@/stores/epics/mobile-switcher-store";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

/**
 * The task's tiles in a popover under a tile's name, opened from a
 * `MobileLevel2MenuTrigger` somewhere in `children`. What is chosen from it lands
 * in that tile's slot. The first slot's open is the switcher's own flag, so a
 * comment thread that asks the switcher to open opens this; the second's is its
 * own, so the two do not open together.
 *
 * The plate renders here and not beside its trigger on purpose: the trigger sits
 * in the tile's bar, which a terminal tile scopes to its own host, and the list
 * belongs to the task. The root stays mounted in every form so a bar whose form
 * changes keeps its state.
 */
export function MobileTileMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly slot: MobileTileSlot;
  /** Whether level 2 is the menu right now. */
  readonly drawn: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const { epicId, tabId, slot, drawn, children } = props;
  const switcherOpen = useIsMobileSwitcherOpen(tabId);
  const setSwitcherOpen = useMobileSwitcherStore((s) => s.setOpen);
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const menuOpen = (slot === "primary" ? switcherOpen : secondaryOpen) && drawn;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (slot === "primary") setSwitcherOpen(tabId, next);
      else setSecondaryOpen(next);
    },
    [setSwitcherOpen, slot, tabId],
  );
  const handleClose = useCallback(
    () => handleOpenChange(false),
    [handleOpenChange],
  );
  const openTarget = useMemo(() => ({ tabId, slot }), [slot, tabId]);
  return (
    <Popover open={menuOpen} onOpenChange={handleOpenChange}>
      {children}
      {drawn ? (
        <MobileLevel2MenuContent
          label="Switch tab"
          testId="mobile-tile-menu"
          tall
        >
          <div
            data-mobile-shell-touch-scope=""
            className="flex min-h-0 flex-1 flex-col"
          >
            <MobileTileOpenTargetContext value={openTarget}>
              <TileSwitcherList
                epicId={epicId}
                tabId={tabId}
                onClose={handleClose}
              />
            </MobileTileOpenTargetContext>
          </div>
        </MobileLevel2MenuContent>
      ) : null}
    </Popover>
  );
}
