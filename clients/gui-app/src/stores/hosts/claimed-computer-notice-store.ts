import { create } from "zustand";
import { persistKey, STORE_KEYS } from "@/lib/persist";
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

/** A claim this person made in this window, of `hostId` on `environmentId`. */
export interface OwnClaim {
  readonly environmentId: string;
  readonly hostId: string;
}

interface OwnClaimsState {
  /** Per viewer: their claims whose record authn has not yet been read. */
  readonly byViewer: Readonly<Record<string, readonly OwnClaim[]>>;
}

/**
 * The claims this person just made here. The next read of that team takes
 * the newest claim of each such computer as told without telling it: it is
 * this person's own claim, not a teammate's.
 */
export const useOwnClaimsStore = create<OwnClaimsState>()(() => ({
  byViewer: {},
}));

export function noteOwnClaim(viewerUserId: string, claim: OwnClaim): void {
  useOwnClaimsStore.setState((state) => ({
    byViewer: {
      ...state.byViewer,
      [viewerUserId]: [...(state.byViewer[viewerUserId] ?? []), claim],
    },
  }));
}

/** The read of `environmentId` answered: its own claims are settled. */
export function settleOwnClaims(
  viewerUserId: string,
  environmentId: string,
): void {
  useOwnClaimsStore.setState((state) => {
    const claims = state.byViewer[viewerUserId] ?? [];
    const kept = claims.filter(
      (claim) => claim.environmentId !== environmentId,
    );
    if (kept.length === claims.length) return state;
    return { byViewer: { ...state.byViewer, [viewerUserId]: kept } };
  });
}
