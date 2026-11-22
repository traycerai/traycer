import { useCallback, useEffect } from "react";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { useMobileTileListForm } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";
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
 * The sheet draws only in the `bar` form. In the `pane` form each tile's own
 * header mounts its sheet, the first tile's over the same open flag.
 */
export function MobileTabSwitcherMount(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const form = useMobileTileListForm(tabId);
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
  if (form !== "bar") return null;
  return (
    <TabSwitcherSheet
      epicId={epicId}
      tabId={tabId}
      open={open}
      onOpenChange={handleOpenChange}
      target={null}
    />
  );
}
