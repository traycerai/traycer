import { useCallback } from "react";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import {
  clearPendingTerminalFocus,
  focusTerminalInstance,
  terminalFocusOwnsInstance,
} from "@/lib/terminals/terminal-focus-registry";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";

/**
 * Retires a tab whose session ended on its own (no kill owed), and moves the
 * keyboard somewhere sensible if that tab had it: to the panel's next tab
 * when there is one, else back to the composer. Shared by the legacy
 * bootstrap and the sign-in tile's Close, so the two cannot drift.
 */
export function useRemoveExitedLandingTab(
  landingPageId: string,
): (instanceId: string) => void {
  const removeExitedTab = useLandingTerminalStore(
    (state) => state.removeExitedTab,
  );
  return useCallback(
    (instanceId: string): void => {
      const ownsFocus = terminalFocusOwnsInstance(instanceId);
      const wasActive =
        useLandingTerminalStore.getState().activeInstanceId === instanceId;
      removeExitedTab(landingPageId, instanceId);
      if (!wasActive || !ownsFocus) return;
      const state = useLandingTerminalStore.getState();
      if (
        landingTerminalLayoutFor(state, landingPageId).panelOpen &&
        state.activeInstanceId !== null
      ) {
        focusTerminalInstance(state.activeInstanceId);
        return;
      }
      clearPendingTerminalFocus(instanceId);
      focusActiveComposer();
    },
    [landingPageId, removeExitedTab],
  );
}
