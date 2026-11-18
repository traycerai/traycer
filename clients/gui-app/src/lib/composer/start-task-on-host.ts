import { browserTabId } from "@/lib/browser-tab-identity";
import { getDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/**
 * Pins this window's landing composer to `hostId`, so the next new-task draft
 * opens on it. The draft's owner then follows the host's team.
 */
export function pinComposerHost(hostId: string): void {
  const windowId = getDesktopEpicOwnershipBridge()?.windowId ?? browserTabId();
  useSurfaceHostSelectionStore
    .getState()
    .setSelection(composerSurfaceKey(windowId), hostId);
}
