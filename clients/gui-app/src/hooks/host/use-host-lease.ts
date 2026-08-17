import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  leaseEquals,
  type HostLeaseSnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * {@link leaseEquals} lifted over the hook's nullable answer, which the
 * comparator itself does not model: `null` is "the authority has published no
 * lease for this host", not a lease value.
 */
function selectedLeaseEquals(
  a: HostLeaseSnapshot | null,
  b: HostLeaseSnapshot | null,
): boolean {
  if (a === null || b === null) return a === b;
  return leaseEquals(a, b);
}

/**
 * This window's lease for ONE host (connection registry §1: all status UI
 * derives from the lease vocabulary - no surface reads sockets, probe caches,
 * or the cloud DTO directly).
 *
 * `null` means the authority has published no lease for this host. It is NOT
 * "dead": before this window's kernel attaches, every host answers `null`
 * because nobody has spoken yet. Any surface presenting a FAILURE off a null
 * lease must pair this with `useSelectionAuthorityAttached()`, which exists to
 * tell that bootstrap apart from the real ∅ - or, better, bound the wait with
 * `useBoundedHostLoad`, which does both.
 *
 * The per-host projection is deliberately the only one of its kind: a second
 * hook answering "what is host X's status" is how this codebase acquired the
 * layered narration this epic is deleting.
 *
 * ## Selected BY VALUE, and that is load-bearing rather than an optimization
 *
 * Lease object identity is never stable across a delivery, so an identity
 * compare here would re-render every consumer on every publish - including
 * consumers of a host whose verdict did not move. This selects with
 * {@link leaseEquals}, the SAME comparator the engine gates its emission on,
 * so a consumer re-renders exactly when the verdict it named actually changed.
 *
 * ⚠ THE INSTABILITY HAS TWO CAUSES AND ONLY ONE OF THEM IS THE IPC BOUNDARY.
 * Naming just the boundary is what makes this caveat look inapplicable to
 * whoever is reading it:
 *
 *  1. The PRODUCER never had a stable identity to hand on. Every commit
 *     re-derives the WHOLE fleet (`selection-authority-engine.ts` -
 *     `deriveLeases` maps `fleet.hosts`, and `deriveLease` returns a fresh
 *     object literal on every arm), so one host's verdict changing allocates a
 *     new object for every OTHER host too.
 *  2. On desktop the preload bridge then re-parses the wire envelope
 *     (`parseRevisionedLeaseSnapshots`, called from
 *     `electron-preload/selection-authority-bridge.ts`), allocating a second
 *     fresh set. This is the IPC deserialization step, and a parser cannot
 *     preserve identity - that is what parsing is.
 *
 * Cause 2 does not run in browser/dev at all: `in-process-selection-authority.ts`
 * wires `engine.onLeasesChanged` straight through and says so in its header
 * ("There is no wire, so no parser runs here"). Cause 1 runs in both. So a
 * reader who checked an IPC-only explanation against the browser topology
 * would find no parser, conclude the caveat was stale, and be entitled to
 * delete it - while the instability it describes was still there.
 *
 * The kernel is the near-miss worth recording: it genuinely does run
 * in-process in this renderer (`kernel.onChange(apply)`), which is exactly
 * what makes the IPC cause look refuted. It is its INPUT that crosses. The
 * kernel itself preserves identity faithfully and only ever forwards
 * (`selection-evidence-kernel.ts` - `applyLeases` takes the incoming array
 * wholesale; `applySelection` carries the current one forward unchanged), so
 * it can keep stable only what it is handed, and it is handed new objects
 * every time.
 */
export function useHostLease(hostId: string | null): HostLeaseSnapshot | null {
  return useStoreWithEqualityFn(
    useSelectionAuthorityStore,
    (state) =>
      hostId === null
        ? null
        : (state.leases.find((lease) => lease.hostId === hostId) ?? null),
    selectedLeaseEquals,
  );
}

/**
 * Every published lease, for surfaces that render the FLEET rather than one
 * host (Settings' hosts list, the window modal's no-usable-host derivation).
 *
 * Returns the store's array by reference, and `applyKernelSnapshot` stores a
 * fresh array per publish - so this re-renders its consumer on every publish
 * whether or not any lease it cares about moved. {@link useHostLease} above
 * does not, because it compares by value; this cannot, because "the fleet" has
 * no smaller answer to compare.
 *
 * ⚠ `useShallow` IS ONLY A REMEDY WHEN THE SELECTOR DERIVES PRIMITIVES. The
 * elements are fresh objects per delivery (see {@link useHostLease}'s note on
 * the two causes), so a shallow compare of two arrays of them is unequal on
 * every element - a selector that FILTERS or SLICES leases gets no benefit at
 * all, and reads as fixed. A selector mapping to ids, statuses or a derived
 * boolean does work, and that is the shape to reach for:
 * `use-composer-placement.ts` memoizes on a derived boolean for exactly this
 * reason.
 */
export function useHostLeases(): readonly HostLeaseSnapshot[] {
  return useSelectionAuthorityStore((state) => state.leases);
}
