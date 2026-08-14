import { create } from "zustand";

/**
 * Per-HOST latches for the OS-service writes, module-scoped on purpose.
 *
 * They used to be component state in the service adapter, and that had two
 * structural holes the review rounds surfaced one each:
 *
 * - The Overview panel is keyed by host id. Switching Settings to another
 *   host unmounts the panel, discarding a latch mid-shutdown — and TanStack
 *   drops per-`mutate` callbacks once the observer is gone, so a settle that
 *   arrived after the switch never armed the latch at all. Coming back to the
 *   host then showed live controls while the detached CLI was still stopping
 *   it. The store survives the remount, and the ARM sites live at hook level
 *   in `host-overview-rpc.ts` (beside the invalidations, which are hook-level
 *   for exactly the same reason), keyed by the mutation's own host id.
 *
 * - `accepted` is a dispatch, not an outcome: the detached CLI can die
 *   without stopping the host, the scope then never flips, and an
 *   unreleasable latch locks the whole page for the visit. Both transient
 *   latches therefore carry their ARM TIME, and the adapter runs a bounded
 *   timer off it — a shutdown or launchd cycle is seconds, so a latch nothing
 *   released within its window is guarding an operation that finished or
 *   never happened.
 *
 * `externallyManagedRefusal` is deliberately un-timed: it records a
 * STRUCTURAL refusal (the supervisor is configured into the host's
 * environment), released only by a scope flip — a new process that may have
 * been reconfigured.
 */
export interface HostServiceWriteLatches {
  readonly deregisterAcceptedAt: number | null;
  readonly registerRestartLikelyAt: number | null;
  /**
   * An accepted `host.update.install`: the detached swap is starting but has
   * not yet published `host.status.updateProgress`, and that gap is wide
   * enough for a restart or service write to race the install being granted.
   * Released when progress appears, on a scope flip, or by a bounded timer.
   */
  readonly updateInstallAcceptedAt: number | null;
  readonly externallyManagedRefusal: boolean;
}

const EMPTY_LATCHES: HostServiceWriteLatches = {
  deregisterAcceptedAt: null,
  registerRestartLikelyAt: null,
  updateInstallAcceptedAt: null,
  externallyManagedRefusal: false,
};

interface HostServiceWriteLatchState {
  readonly byHost: Readonly<Record<string, HostServiceWriteLatches>>;
  readonly armDeregisterAccepted: (hostId: string) => void;
  readonly armRegisterRestartLikely: (hostId: string) => void;
  readonly armUpdateInstallAccepted: (hostId: string) => void;
  readonly armExternallyManagedRefusal: (hostId: string) => void;
  readonly releaseDeregisterAccepted: (hostId: string) => void;
  readonly releaseRegisterRestartLikely: (hostId: string) => void;
  readonly releaseUpdateInstallAccepted: (hostId: string) => void;
  readonly releaseExternallyManagedRefusal: (hostId: string) => void;
  /** The scope-flip release: every latch for this host, structural included. */
  readonly releaseAll: (hostId: string) => void;
}

export const useHostServiceWriteLatchStore = create<HostServiceWriteLatchState>(
  (set) => {
    const patch = (
      hostId: string,
      change: Partial<HostServiceWriteLatches>,
    ): void => {
      set((state) => ({
        byHost: {
          ...state.byHost,
          [hostId]: { ...(state.byHost[hostId] ?? EMPTY_LATCHES), ...change },
        },
      }));
    };
    return {
      byHost: {},
      armDeregisterAccepted: (hostId) => {
        patch(hostId, { deregisterAcceptedAt: Date.now() });
      },
      armRegisterRestartLikely: (hostId) => {
        patch(hostId, { registerRestartLikelyAt: Date.now() });
      },
      armUpdateInstallAccepted: (hostId) => {
        patch(hostId, { updateInstallAcceptedAt: Date.now() });
      },
      armExternallyManagedRefusal: (hostId) => {
        patch(hostId, { externallyManagedRefusal: true });
      },
      releaseDeregisterAccepted: (hostId) => {
        patch(hostId, { deregisterAcceptedAt: null });
      },
      releaseRegisterRestartLikely: (hostId) => {
        patch(hostId, { registerRestartLikelyAt: null });
      },
      releaseUpdateInstallAccepted: (hostId) => {
        patch(hostId, { updateInstallAcceptedAt: null });
      },
      releaseExternallyManagedRefusal: (hostId) => {
        patch(hostId, { externallyManagedRefusal: false });
      },
      releaseAll: (hostId) => {
        set((state) => {
          if (!(hostId in state.byHost)) return state;
          const next = { ...state.byHost };
          delete next[hostId];
          return { byHost: next };
        });
      },
    };
  },
);

/** Test-only: drops every host's latches, mirroring a fresh module load. */
export function resetHostServiceWriteLatchesForTest(): void {
  useHostServiceWriteLatchStore.setState({ byHost: {} });
}

export function hostServiceWriteLatches(
  byHost: Readonly<Record<string, HostServiceWriteLatches>>,
  hostId: string | null,
): HostServiceWriteLatches {
  if (hostId === null) return EMPTY_LATCHES;
  return byHost[hostId] ?? EMPTY_LATCHES;
}
