import { create } from "zustand";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";

/**
 * The window's READ-ONLY projection of the selection authority (D16).
 *
 * The authority owns `preferredHostId` and derives `effectiveHostId` in the
 * desktop main process; this store is where the one renderer-side bridge
 * (`mountSelectionAuthorityBridge`) parks the kernel snapshot so React can
 * read it. It has exactly ONE writer, and it is not a picker: every UI
 * gesture that wants to move the app-wide selection goes UP through
 * `SelectionAuthorityClient.activate(...)` and comes back DOWN through here
 * (selection model §1, invariant 1). Nothing in the tree may `set` it.
 *
 * Deliberately NOT persisted. `preferredHostId` is persisted by the
 * authority, identity-scoped, and `effectiveHostId` is derived - never
 * persisted, by definition (selection model §1). A persisted copy here would
 * be a second answer to "which host is this window on" that outlives the
 * process that computed it.
 *
 * `effectiveHostId` is the value `useEffectiveHostId()` publishes, and it is
 * read from HERE rather than from the bound `HostClient`: the authority can
 * name a host the directory has no row for yet, and the client's answer for
 * that window is `null` - which is the same answer it gives for "no host at
 * all". Two different facts, one value, is exactly the conflation the
 * derivation replaced.
 */
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

/**
 * The app-wide pointer for a caller with no render to hang a hook on.
 *
 * Named and single-homed rather than left as an inline `getState()` at each
 * call site, because the non-React reads of this value are exactly the ones
 * that must stay greppable: they are how event-edge code (a router loader, a
 * guard checking whether the pointer moved mid-route) asks the same question
 * `useEffectiveHostId()` asks in render. `null` means ∅ here too - nothing
 * usable - and a caller that needs "is it addressable yet" resolves it
 * through a requester instead.
 */
export function readEffectiveHostIdSnapshot(): string | null {
  return useSelectionAuthorityStore.getState().effectiveHostId;
}
