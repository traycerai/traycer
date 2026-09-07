import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * App-wide selection pointer from the authority projection, not the bound client. Client `null` cannot distinguish "row not arrived" from "no host". `null` here is empty selection only.
 */
export function useEffectiveHostId(): string | null {
  return useSelectionAuthorityStore((state) => state.effectiveHostId);
}
