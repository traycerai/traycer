import { useLayoutEffect } from "react";
import {
  claimHostedPaneActivation,
  claimHostedPaneActivationFocus,
} from "@/components/epic-canvas/pane-activation";
import {
  claimHostedTopLevelActivationFocus,
  claimHostedTopLevelActivationPointerDown,
} from "@/components/epic-canvas/surface-host/hosted-top-level-activation";
import {
  startPersistentBrowserGuestHost,
  stopPersistentBrowserGuestHost,
  type BrowserGuestActivateEvent,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { useRunnerHost } from "@/providers/use-runner-host";

function activateGuestPointer(
  viewTabId: string,
  paneId: string,
  event: BrowserGuestActivateEvent,
): void {
  claimHostedPaneActivation(viewTabId, paneId, event);
  claimHostedTopLevelActivationPointerDown(
    event.target,
    event.defaultPrevented,
  );
}

function activateGuestFocus(
  viewTabId: string,
  paneId: string,
  event: BrowserGuestActivateEvent,
): void {
  claimHostedPaneActivationFocus(viewTabId, paneId, event);
  claimHostedTopLevelActivationFocus(event.target, event.defaultPrevented);
}

/**
 * Window-level guest host. First child of RunnerHostProvider so its
 * layout effect runs before later siblings (session coordinators) start.
 */
export function PersistentBrowserGuestHost(): null {
  const { browserView } = useRunnerHost();
  useLayoutEffect(() => {
    if (browserView === null) return undefined;
    startPersistentBrowserGuestHost(browserView, {
      pointerDown: activateGuestPointer,
      focus: activateGuestFocus,
    });
    return stopPersistentBrowserGuestHost;
  }, [browserView]);
  return null;
}
