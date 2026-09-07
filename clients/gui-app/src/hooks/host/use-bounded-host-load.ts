import { useMemo } from "react";
import type { HostLeaseDeadState } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useLoadDeadline } from "@/hooks/host/use-load-deadline";
import { TILE_CONTENT_BUDGET_MS } from "@/lib/host/bounded-load-budgets";

/** What a surface waiting on host data should show. */
export type BoundedHostLoad =
  /** Nothing is pending - the caller has content to render. */
  | { readonly kind: "ready" }
  /** The host is up; its data is in flight. Within budget. */
  | { readonly kind: "loading"; readonly hostLabel: string | null }
  /** The host is not up YET (or the authority hasn't spoken). Within budget. */
  | { readonly kind: "connecting"; readonly hostLabel: string | null }
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
   * Caller supplies the label (already from `useHostReachability`). `null` prints "the host", never a raw id.
   */
  readonly hostLabel: string | null;
  /** True while the surface still has nothing to show. */
  readonly pending: boolean;
}

/** Dead lease short-circuits the deadline. Key the deadline on host id, not lease status (flaps must not re-arm). */
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
    // A null lease is the authority not having spoken (this window's kernel may not have attached), which reads as connecting - bounded by the same deadline, since invariant 6 does not exempt a bridge that never attaches.
    if (
      lease !== null &&
      (lease.status === "ready" || lease.status === "degraded")
    ) {
      return { kind: "loading", hostLabel };
    }
    return { kind: "connecting", hostLabel };
  }, [deadlineElapsed, hostLabel, lease, pending]);
}
