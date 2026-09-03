import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import { defaultLandingBrowserTitle } from "./use-landing-browser-reconciliation";

/**
 * What the strip renders for one browser row - the browser counterpart of
 * `PlainTerminalViewModel`, and deliberately the same three questions: what to
 * call it, whether it is dormant, and whether its device is reporting at all.
 */
export interface LandingBrowserViewModel {
  readonly displayTitle: string;
  /** The live address, for the row's tooltip. `null` while unknown. */
  readonly address: string | null;
  readonly isDormant: boolean;
  /** The device has not published an inventory this row can be read against. */
  readonly isRuntimeUnknown: boolean;
}

export function selectLandingBrowserViewModel(args: {
  readonly tab: LandingBrowserTabRef;
  readonly sessions: BrowserSessionsState | null;
}): LandingBrowserViewModel {
  const stored: LandingBrowserViewModel = {
    displayTitle: args.tab.name,
    address: null,
    isDormant: false,
    isRuntimeUnknown: false,
  };
  const sessions = args.sessions;
  if (sessions === null || !sessions.inventoryReady) {
    return { ...stored, isRuntimeUnknown: true };
  }
  // Host and scope are re-checked even though the caller resolves `sessions`
  // by `tab.hostId`, matching the reconciler's posture in
  // `reconcileLandingBrowserTabs`: a session id is unique per device, so
  // matching on it alone would resolve a STRANGER'S tab under this row's name
  // if a caller ever handed over the wrong device's inventory. Failing to find
  // it reads as "gone", which is the safe direction.
  const session = sessions.items.find(
    (item) =>
      item.sessionId === args.tab.sessionId &&
      item.hostId === args.tab.hostId &&
      item.scope.kind === "independent",
  );
  const live = session?.tabs.find((item) => item.tabId === args.tab.tabId);
  // Ready and absent: the reconciler is about to drop this row. It is not
  // "status unavailable" - the device answered, and the answer was "gone".
  if (session === undefined || live === undefined) return stored;
  return {
    // Read from the snapshot rather than from `tab.name`, which the reconciler
    // syncs in an effect and is therefore one commit behind. A manual title is
    // the user's and is never overwritten by either path.
    displayTitle:
      args.tab.titleSource === "manual"
        ? args.tab.name
        : defaultLandingBrowserTitle(live),
    address: live.url,
    isDormant: live.status === "dormant" || session.runtime.kind === "dormant",
    isRuntimeUnknown: false,
  };
}
