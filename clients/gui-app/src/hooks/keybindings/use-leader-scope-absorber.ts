import { useLayoutEffect } from "react";
import { registerLeaderScope } from "@/lib/keybindings/leader-scope";

/**
 * While `open`, registers a leader scope under `scopeId` that CLAIMS both
 * leaders - `mod` via `tab.switch.byDigit`, `alt` via `epic.switch.byDigit` -
 * and no-ops their digit dispatch.
 *
 * Use it for an overlay that opts out of the keybinding provider's dialog block
 * (`data-leader-scope`) but exposes no leader shortcuts of its own. Because the
 * scope sits above the always-present canvas/header-tab base scopes, leader
 * digits are swallowed here instead of switching the tabs behind the overlay,
 * and no hint badges light up (no badge consumer subscribes to `scopeId`). A
 * nested leader-aware overlay (e.g. the model picker) registers later, so it
 * sits ABOVE this absorber and reclaims the modifiers while it is open.
 */
export function useLeaderScopeAbsorber(open: boolean, scopeId: string): void {
  // `useLayoutEffect`, not `useEffect`: the modal exposes `data-leader-scope`
  // the moment it renders, which makes it transparent to `isAnyDialogOpen()`.
  // Registering after paint would leave a frame on open where leader digits
  // reach the base tab scopes behind the modal (and a matching frame on close
  // where the absorber outlives the dialog). Installing the scope before paint
  // closes both windows. gui-app is browser-only, so no SSR guard is needed.
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
