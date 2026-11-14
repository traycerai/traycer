import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";
import {
  createKeyedSeenStore,
  keyedSeen,
} from "@/lib/persist/keyed-seen-store";

/**
 * The claims this device has told each person about, keyed by viewer and
 * claim: the owner's sentence is shown once per device. authn keeps a claim
 * 30 days, so the cap only has to outlast that.
 */
const CLAIM_NOTICES_TOLD_CAP = 500;

export const useClaimNoticesToldStore = createKeyedSeenStore(
  persistKey(STORE_KEYS.claimNoticesTold),
  CLAIM_NOTICES_TOLD_CAP,
);

/**
 * Take a claim's notice for this window: `true` exactly once per device and
 * person. Re-reads storage first, so a second window does not tell it again.
 */
export function takeClaimNotice(
  viewerUserId: string,
  claimKey: string,
): boolean {
  const store = useClaimNoticesToldStore;
  void store.persist.rehydrate();
  if (keyedSeen(store.getState().seen, viewerUserId, claimKey)) return false;
  store.getState().markSeen(viewerUserId, claimKey);
  return true;
}

/** A team computer this device has seen in the person's list. */
export interface SeenTeamComputer {
  readonly teamId: string;
  readonly teamName: string;
}

type SeenComputers = Readonly<Record<string, SeenTeamComputer>>;

interface TeamComputersSeenState {
  /** Per viewer: the team computers this device last saw in their list. */
  readonly byViewer: Readonly<Record<string, SeenComputers>>;
  readonly setSeen: (viewerUserId: string, computers: SeenComputers) => void;
  /** The person claimed this computer here: it leaves the list untold. */
  readonly forgetComputer: (viewerUserId: string, hostId: string) => void;
}

const TEAM_COMPUTERS_SEEN_PERSIST_KEY = persistKey(
  STORE_KEYS.teamComputersSeen,
);

function isSeenComputer(value: unknown): value is SeenTeamComputer {
  return (
    typeof value === "object" &&
    value !== null &&
    "teamId" in value &&
    typeof value.teamId === "string" &&
    "teamName" in value &&
    typeof value.teamName === "string"
  );
}

/** A corrupt entry is dropped: one notice missed, never a wrong one. */
function persistedByViewer(
  persistedState: unknown,
): Readonly<Record<string, SeenComputers>> {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  if (!("byViewer" in persistedState)) return {};
  const byViewer = persistedState.byViewer;
  if (typeof byViewer !== "object" || byViewer === null) return {};
  const next: Record<string, SeenComputers> = {};
  const viewers: ReadonlyArray<readonly [string, unknown]> =
    Object.entries(byViewer);
  for (const [viewer, computers] of viewers) {
    if (typeof computers !== "object" || computers === null) continue;
    const entries: ReadonlyArray<readonly [string, unknown]> =
      Object.entries(computers);
    const kept: Record<string, SeenTeamComputer> = {};
    for (const [hostId, computer] of entries) {
      if (isSeenComputer(computer)) kept[hostId] = computer;
    }
    next[viewer] = kept;
  }
  return next;
}

/**
 * The team computers each person's list carried when this device last
 * looked, so a computer that leaves the list while the app was closed is
 * still noticed at the next open.
 */
export const useTeamComputersSeenStore = create<TeamComputersSeenState>()(
  persist(
    (set) => ({
      byViewer: {},
      setSeen: (viewerUserId, computers) => {
        set((state) => ({
          byViewer: { ...state.byViewer, [viewerUserId]: computers },
        }));
      },
      forgetComputer: (viewerUserId, hostId) => {
        set((state) => {
          if (!Object.hasOwn(state.byViewer, viewerUserId)) return state;
          const computers = state.byViewer[viewerUserId];
          if (!Object.hasOwn(computers, hostId)) return state;
          const { [hostId]: _claimed, ...rest } = computers;
          return { byViewer: { ...state.byViewer, [viewerUserId]: rest } };
        });
      },
    }),
    {
      ...basePersistOptions(TEAM_COMPUTERS_SEEN_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        byViewer: persistedByViewer(persistedState),
      }),
      partialize: (state) => ({ byViewer: state.byViewer }),
    },
  ),
);

installCrossWindowRehydrate(
  useTeamComputersSeenStore,
  TEAM_COMPUTERS_SEEN_PERSIST_KEY,
);
