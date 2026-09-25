import { useCallback, useEffect } from "react";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { isMobileApp } from "@/lib/mobile-app";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
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
 * On the installed app it is also where this epic's `resources.subscribe`
 * stream lives: the sheet's agent and terminal rows are the only place the
 * phone shows the epic's resource chips, so the stream is held while the sheet
 * is open and released when it closes (`EpicShell` opens one there only for an
 * old host's global fallback). Off the app the pane's own mount already holds
 * it, and this adds nothing.
 */
export function MobileTabSwitcherMount(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
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
  return (
    <>
      {open && isMobileApp() ? <ResourcesStreamMount epicId={epicId} /> : null}
      <TabSwitcherSheet
        epicId={epicId}
        tabId={tabId}
        open={open}
        onOpenChange={handleOpenChange}
      />
    </>
  );
}
