import { useMemo } from "react";
import type { HostLeaseDeadState } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useLoadDeadline } from "@/hooks/host/use-load-deadline";
import { TILE_CONTENT_BUDGET_MS } from "@/lib/host/bounded-load-budgets";

/**
 * What a surface waiting on host data should show. TOTAL by construction:
 * there is no arm that means "keep spinning indefinitely", which is the whole
 * point (audit S3/S4 - `enabled:false` leaves `isPending` true, `data`
 * undefined and `error` null forever, a shape every caller reads as "still
 * loading" because it is indistinguishable from one).
 */
export type BoundedHostLoad =
  /** Nothing is pending - the caller has content to render. */
  | { readonly kind: "ready" }
  /** The host is up; its data is in flight. Within budget. */
  | { readonly kind: "loading"; readonly hostLabel: string | null }
  /** The host is not up YET (or the authority hasn't spoken). Within budget. */
  | { readonly kind: "connecting"; readonly hostLabel: string | null }
  /** The lease says dead. Terminal IMMEDIATELY - no waiting out the budget. */
  | {
      readonly kind: "dead";
      readonly dead: HostLeaseDeadState;
      readonly hostLabel: string | null;
    }
  /** The budget elapsed with no data and no verdict. Terminal, retryable. */
  | { readonly kind: "timed-out"; readonly hostLabel: string | null };

const READY: BoundedHostLoad = { kind: "ready" };

export interface UseBoundedHostLoadArgs {
  readonly hostId: string;
  /**
   * The label to name the host by, supplied by the CALLER rather than
   * re-resolved here. Every caller already renders a host name from
   * `useHostReachability`, and a second resolution is how one surface ends up
   * describing one host two ways.
   *
   * `null` when the directory has not resolved a label yet, in which case the
   * copy says "the host" rather than printing a raw id at a person. Callers
   * on a `HostReachability` should pass `resolvedHostLabel(reachability)`,
   * which encodes that rule once.
   */
  readonly hostLabel: string | null;
  /** True while the surface still has nothing to show. */
  readonly pending: boolean;
}

/**
 * Bounds a host-dependent wait and names it (invariant 6).
 *
 * Replaces the "disabled query renders a spinner" family at its seam. The
 * caller keeps whatever pending signal it already had - a `useHostQuery`
 * that disables itself on a null client, a stream subscription that never
 * delivers, a chat-session handle that never resolves - and hands it in as
 * `pending`; this decides what the user is told about it. The three producers
 * are deliberately not distinguished, because the sentence a person needs
 * ("<host> hasn't answered") is the same for all three and the difference
 * between them is not knowledge the reader can act on.
 *
 * A `dead` lease short-circuits the deadline. F13 says to render the LEASE
 * state, and a lease that already answered `plan-restricted` must not make
 * the reader wait out a 15s budget to be told a fact the authority has
 * already published.
 *
 * The deadline is keyed on the host alone, NOT on the lease status: keying it
 * on status would re-arm the budget on every connecting→degraded→connecting
 * flap, and a flapping host is exactly the case that must still terminate.
 */
export function useBoundedHostLoad(
  args: UseBoundedHostLoadArgs,
): BoundedHostLoad {
  const { hostId, hostLabel, pending } = args;
  const lease = useHostLease(pending ? hostId : null);
  const deadlineElapsed = useLoadDeadline(
    pending ? hostId : null,
    TILE_CONTENT_BUDGET_MS,
  );

  return useMemo<BoundedHostLoad>(() => {
    if (!pending) return READY;
    if (lease !== null && lease.status === "dead") {
      return { kind: "dead", dead: lease.dead, hostLabel };
    }
    if (deadlineElapsed) return { kind: "timed-out", hostLabel };
    // `ready`/`degraded` mean the host itself is up, so "connecting to X"
    // would be false about the machine and would send the reader looking at
    // the wrong thing. A null lease is the authority not having spoken (this
    // window's kernel may not have attached), which reads as connecting -
    // bounded by the same deadline, since invariant 6 does not exempt a
    // bridge that never attaches.
    if (
      lease !== null &&
      (lease.status === "ready" || lease.status === "degraded")
    ) {
      return { kind: "loading", hostLabel };
    }
    return { kind: "connecting", hostLabel };
  }, [deadlineElapsed, hostLabel, lease, pending]);
}
