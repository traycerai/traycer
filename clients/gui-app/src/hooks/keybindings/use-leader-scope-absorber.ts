import { useLayoutEffect } from "react";
import { registerLeaderScope } from "@/lib/keybindings/leader-scope";

/**
 * While `open`, claim both leaders under `scopeId` and no-op digit dispatch so overlay digits do not switch tabs behind it. A nested leader-aware overlay registers later and sits above this.
 */
export function useLeaderScopeAbsorber(open: boolean, scopeId: string): void {
  // Registering after paint would leave a frame on open where leader digits reach the base tab scopes behind the modal (and a matching frame on close where the absorber outlives the dialog).
  useLayoutEffect(() => {
    if (!open) return;
    return registerLeaderScope({
      id: scopeId,
      actions: [
        {
          actionId: "tab.switch.byDigit",
          isActive: () => true,
          dispatch: () => true,
          dispatchSequence: null,
          sequenceState: null,
        },
        {
          actionId: "epic.switch.byDigit",
          isActive: () => true,
          dispatch: () => true,
          dispatchSequence: null,
          sequenceState: null,
        },
      ],
    });
  }, [open, scopeId]);
}
