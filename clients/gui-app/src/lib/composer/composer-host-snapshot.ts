import { browserTabId } from "@/lib/browser-tab-identity";
import { getDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  composerSurfaceKey,
  resolvedSurfaceHostId,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

/** Imperative counterpart of useComposerSurfaceHostPin, for draft creation. */
export function readComposerHostIdSnapshot(): string | null {
  const windowId = getDesktopEpicOwnershipBridge()?.windowId ?? browserTabId();
  const selection =
    useSurfaceHostSelectionStore.getState().selections[
      composerSurfaceKey(windowId)
    ] ?? null;
  const authority = useSelectionAuthorityStore.getState();
  return resolvedSurfaceHostId(selection, authority.effectiveHostId, {
    authorityAttached: authority.attached,
    leases: authority.leases,
  });
}
