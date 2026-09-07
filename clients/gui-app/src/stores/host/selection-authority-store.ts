import { create } from "zustand";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";

/** The window's READ-ONLY projection of the selection authority (D16). */
export interface SelectionAuthorityStoreState {
  /** False until this window's kernel has attached (or after it detached). */
  readonly attached: boolean;
  readonly preferredHostId: string | null;
  /** Preferred, or the local host when preferred is null (M5), or null. */
  readonly targetHostId: string | null;
  readonly effectiveHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly applyKernelSnapshot: (snapshot: SelectionKernelSnapshot) => void;
  /** Back to detached. The bridge calls this on unmount; tests reuse it. */
  readonly reset: () => void;
}

const DETACHED = {
  attached: false,
  preferredHostId: null,
  targetHostId: null,
  effectiveHostId: null,
  leases: [] as readonly HostLeaseSnapshot[],
};

export const useSelectionAuthorityStore =
  create<SelectionAuthorityStoreState>()((set) => ({
    ...DETACHED,
    applyKernelSnapshot: (snapshot) => {
      set({
        attached: snapshot.attached,
        preferredHostId: snapshot.preferredHostId,
        targetHostId: snapshot.targetHostId,
        effectiveHostId: snapshot.effectiveHostId,
        leases: snapshot.leases,
      });
    },
    reset: () => {
      set(DETACHED);
    },
  }));

/** The app-wide pointer for a caller with no render to hang a hook on. */
export function readEffectiveHostIdSnapshot(): string | null {
  return useSelectionAuthorityStore.getState().effectiveHostId;
}
