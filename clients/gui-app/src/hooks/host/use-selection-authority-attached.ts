import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * Distinguishes `useEffectiveHostId()` nulls: `false` is not attached yet; `true` with a null host is the real empty selection. Failure UI on a null host must gate on this or it flashes during bootstrap.
 */
export function useSelectionAuthorityAttached(): boolean {
  return useSelectionAuthorityStore((state) => state.attached);
}
