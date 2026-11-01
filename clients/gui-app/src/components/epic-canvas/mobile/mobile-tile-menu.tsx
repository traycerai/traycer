import { useCallback, type ReactNode } from "react";
import { TileSwitcherList } from "@/components/epic-canvas/mobile/tile-switcher-list";
import { MobileLevel2MenuContent } from "@/components/layout/shell/mobile-level2";
import { Popover } from "@/components/ui/popover";
import {
  useIsMobileSwitcherOpen,
  useMobileSwitcherStore,
} from "@/stores/epics/mobile-switcher-store";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

/**
 * The task's tiles in a popover under the current tile's name, opened from a
 * `MobileLevel2MenuTrigger` somewhere in `children`. Open is the switcher's own
 * flag, so a comment thread that asks the switcher to open opens this.
 *
 * The plate renders here and not beside its trigger on purpose: the trigger sits
 * in the tile's bar, which a terminal tile scopes to its own host, and the list
 * belongs to the task. The root stays mounted in every form so a bar whose form
 * changes keeps its state.
 */
export function MobileTileMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  /** Whether level 2 is the menu right now. */
  readonly drawn: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const { epicId, tabId, drawn, children } = props;
  const menuOpen = useIsMobileSwitcherOpen(tabId) && drawn;
  const setOpen = useMobileSwitcherStore((s) => s.setOpen);
  const handleOpenChange = useCallback(
    (next: boolean) => setOpen(tabId, next),
    [setOpen, tabId],
  );
  const handleClose = useCallback(
    () => setOpen(tabId, false),
    [setOpen, tabId],
  );
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
            <TileSwitcherList
              epicId={epicId}
              tabId={tabId}
              onClose={handleClose}
            />
          </div>
        </MobileLevel2MenuContent>
      ) : null}
    </Popover>
  );
}
