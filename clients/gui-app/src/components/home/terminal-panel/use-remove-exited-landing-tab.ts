import { useCallback } from "react";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import {
  clearPendingTerminalFocus,
  focusTerminalInstance,
  terminalFocusOwnsInstance,
} from "@/lib/terminals/terminal-focus-registry";
import {
  activeLandingTerminalInstanceId,
  landingPanelLayoutFor,
  useLandingPanelStore,
} from "@/stores/home/landing-panel-store";

/**
 * Retires a tab whose session ended on its own (no kill owed), and moves the
 * keyboard somewhere sensible if that tab had it: to the panel's next TERMINAL
 * tab when there is one, else back to the composer. Shared by the legacy
 * bootstrap and the sign-in tile's Close, so the two cannot drift.
 *
 * The promoted neighbour need not be a terminal: the strip is mixed, and a
 * browser tab or the chooser can be what the exit promotes. Only a terminal
 * claims a terminal focus request, so anything else falls through to the
 * composer.
 */
export function useRemoveExitedLandingTab(
  landingPageId: string,
): (instanceId: string) => void {
  const removeExitedTab = useLandingPanelStore(
    (state) => state.removeExitedTab,
  );
  return useCallback(
    (instanceId: string): void => {
      const ownsFocus = terminalFocusOwnsInstance(instanceId);
      const wasActive =
        useLandingPanelStore.getState().activeInstanceId === instanceId;
      removeExitedTab(landingPageId, instanceId);
      if (!wasActive || !ownsFocus) return;
      const state = useLandingPanelStore.getState();
      const nextTerminal = activeLandingTerminalInstanceId(state);
      if (
        landingPanelLayoutFor(state, landingPageId).panelOpen &&
        nextTerminal !== null
      ) {
        focusTerminalInstance(nextTerminal);
        return;
      }
      clearPendingTerminalFocus(instanceId);
      focusActiveComposer();
    },
    [landingPageId, removeExitedTab],
  );
}
