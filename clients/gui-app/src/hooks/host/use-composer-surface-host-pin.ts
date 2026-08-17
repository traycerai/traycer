import { useMemo } from "react";
import {
  useSurfaceHostPin,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { browserTabId } from "@/lib/browser-tab-identity";
import { composerSurfaceKey } from "@/stores/host/surface-host-selection-store";

/**
 * The composer's surface key: window-scoped (selection model §2 / M4).
 *
 * The composer is the one multi-instance surface whose instances must AGREE -
 * a window shows at most one placement composer at a time (the landing
 * composer, or the app-wide new-conversation modal opened over it), and they
 * all place new work on the same machine. Keying per component instance would
 * let the modal silently contradict the landing chip behind it.
 *
 * Outside desktop there is no windows bridge, so the browser TAB is the window
 * - and it has to be identified, not assumed. This used to fold every browser
 * tab onto the literal key `"browser"`, and because the pin store persists to
 * localStorage (origin-wide, not per-tab) a pin chosen in one tab was hydrated
 * by the next one opened or reloaded. The composer is PLACEMENT, so that tab's
 * new epics and chats were created on a machine another tab had picked, for
 * life. The doc here said it folded "the whole browser tab onto one key"; it
 * folded every tab onto one key, which is the bug.
 *
 * `browserTabId()` is the shared claim protocol, not a `sessionStorage` read -
 * see its module for why the difference matters (a duplicated tab inherits its
 * origin's `sessionStorage`). Desktop keeps its bridge `windowId`, which is
 * already stable and finite.
 */
export function useComposerSurfaceHostKey(): string {
  const bridgeWindowId = useWindowsBridge()?.windowId ?? null;
  // Resolved OUTSIDE the memo's dependency list on purpose: `browserTabId()`
  // is stable for this tab's lifetime after its first call, and reading it
  // here keeps `composerSurfaceKey` a pure function of its argument.
  const windowId = bridgeWindowId ?? browserTabId();
  return useMemo(() => composerSurfaceKey(windowId), [windowId]);
}

/**
 * This window's composer host pin. `selection === null` follows the effective
 * host; `resolvedHostId` is what the chip renders and what every create the
 * composer performs must address (selection model §54 - the composer is
 * placement, and its resolved host decides where a chat/epic lives for life).
 *
 * Writing it is the ONLY thing the composer's host picker does: it never
 * moves the app-wide selection, which is Settings ▸ Activate's alone.
 */
export function useComposerSurfaceHostPin(): SurfaceHostPin {
  const surfaceKey = useComposerSurfaceHostKey();
  return useSurfaceHostPin(surfaceKey);
}
