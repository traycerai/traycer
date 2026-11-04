import { useCallback, useEffect } from "react";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { useMobileTileLevel2Form } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";
import {
  useIsMobileSwitcherOpen,
  useMobileSwitcherStore,
} from "@/stores/epics/mobile-switcher-store";

/**
 * Binds the switcher store to the switcher sheet for one epic tab.
 *
 * The sheet mounts inside the canvas tree, where the epic projection and the
 * providers its embedded panel bodies rely on are in scope, while the trigger
 * that opens it lives in the app header. That is a strictly smaller subtree
 * than the trigger's: the canvas branches that render a skeleton, a snapshot
 * fetch error or a repoint failure never reach here, so the trigger is on
 * screen in states no sheet is listening in. Registering the tab id while
 * mounted is what lets the trigger see that and disable itself, rather than
 * writing an open flag nothing renders.
 *
 * The sheet draws only in the `bar` form. The menu reads the same open flag from
 * under the tile's name. The column is already open, so a request to open
 * (revealing a comment thread asks for one) is answered by being on screen, and
 * is cleared here rather than left to pop the sheet open at the next rotation.
 */
export function MobileTabSwitcherMount(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const level2 = useMobileTileLevel2Form(tabId);
  const open = useIsMobileSwitcherOpen(tabId);
  const setOpen = useMobileSwitcherStore((s) => s.setOpen);
  const registerMount = useMobileSwitcherStore((s) => s.registerMount);
  const unregisterMount = useMobileSwitcherStore((s) => s.unregisterMount);
  const handleOpenChange = useCallback(
    (next: boolean) => setOpen(tabId, next),
    [setOpen, tabId],
  );
  useEffect(() => {
    registerMount(tabId);
    return () => unregisterMount(tabId);
  }, [registerMount, tabId, unregisterMount]);
  const columnDrawn = typeof level2 === "object";
  useEffect(() => {
    if (columnDrawn && open) setOpen(tabId, false);
  }, [columnDrawn, open, setOpen, tabId]);
  if (level2 !== "bar") return null;
  return (
    <TabSwitcherSheet
      epicId={epicId}
      tabId={tabId}
      open={open}
      onOpenChange={handleOpenChange}
    />
  );
}
