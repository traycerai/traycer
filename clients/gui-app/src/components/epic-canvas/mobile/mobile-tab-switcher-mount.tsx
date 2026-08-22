import { useCallback } from "react";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import {
  useIsMobileSwitcherOpen,
  useMobileSwitcherStore,
} from "@/stores/epics/mobile-switcher-store";

/**
 * Binds the switcher store to the switcher sheet for one epic tab.
 *
 * The sheet mounts inside the canvas tree, where the epic projection and the
 * providers its embedded panel bodies rely on are in scope, while the trigger
 * that opens it lives in the app header. Every mobile canvas state that a user
 * can reach mounts this, so the header trigger is never inert.
 */
export function MobileTabSwitcherMount(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const open = useIsMobileSwitcherOpen(tabId);
  const setOpen = useMobileSwitcherStore((s) => s.setOpen);
  const handleOpenChange = useCallback(
    (next: boolean) => setOpen(tabId, next),
    [setOpen, tabId],
  );
  return (
    <TabSwitcherSheet
      epicId={epicId}
      tabId={tabId}
      open={open}
      onOpenChange={handleOpenChange}
    />
  );
}
