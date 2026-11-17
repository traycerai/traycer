import { create } from "zustand";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  createKeyedSeenStore,
  keyedSeen,
} from "@/lib/persist/keyed-seen-store";

// authn keeps a claim 30 days, so the cap only has to outlast that.
const CLAIM_NOTICES_TOLD_CAP = 500;

export const useClaimNoticesToldStore = createKeyedSeenStore(
  persistKey(STORE_KEYS.claimNoticesTold),
  CLAIM_NOTICES_TOLD_CAP,
);

/** Re-reads storage first, so a second window does not tell it again. */
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

export interface OwnClaim {
  readonly environmentId: string;
  readonly hostId: string;
}

interface OwnClaimsState {
  readonly byViewer: Readonly<Record<string, readonly OwnClaim[]>>;
}

/** The next read of that team takes this person's own newest claim of each computer as told, without telling it. */
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
