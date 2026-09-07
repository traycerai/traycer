import { create } from "zustand";

/** `accepted` is a dispatch, not an outcome: the detached CLI can die without stopping the host, the scope then
 * never flips, and an unreleasable latch locks the whole page for the visit. */
export interface HostServiceWriteLatches {
  readonly deregisterAcceptedAt: number | null;
  readonly registerRestartLikelyAt: number | null;
  /** An accepted `host.update.install`: the detached swap is starting but has not yet published
   * `host.status.updateProgress`. */
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
