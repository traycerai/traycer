import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * THE app-wide selection pointer (selection model §1): the host the authority
 * derived for this app, which every following (`null`) surface resolves
 * against and every window-global consumer re-points on.
 *
 * Read from the authority's projection rather than from the bound
 * `HostClient`: the derivation can name a host whose directory row has not
 * arrived, and the client's answer there is `null` - the same answer it gives
 * for "no host at all". `null` here means ∅ (nothing usable), which is the
 * window-modal case, and nothing else.
 */
export function useEffectiveHostId(): string | null {
  return useSelectionAuthorityStore((state) => state.effectiveHostId);
}
