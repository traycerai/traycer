import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";
import { appLogger, describeLogError } from "@/lib/logger";

const VERIFIED_PROFILE_CACHE_KEY = persistKey(STORE_KEYS.verifiedProfileCache);

/** An account's picture and name as authn last answered them on this machine. */
export interface VerifiedProfile {
  readonly avatarUrl: string | null;
  readonly displayName: string;
}

interface VerifiedProfileCacheState {
  readonly profilesByUserId: Readonly<Record<string, VerifiedProfile>>;
  readonly remember: (userId: string, profile: VerifiedProfile) => void;
  readonly forget: (userId: string) => void;
}

/**
 * Runs a write whose persisting may throw (a full or refused `localStorage`).
 * The memory copy has already moved by then, and the callers are auth
 * transitions that a lost picture must never interrupt, so it stops here.
 */
function bestEffort(write: () => void): void {
  try {
    write();
  } catch (error: unknown) {
    appLogger.warn("[auth] verified profile cache write failed", {
      error: describeLogError(error),
    });
  }
}

/**
 * The picture and name a restored session cannot get from the credentials
 * file, which the CLI writes too and whose shape this app cannot widen.
 * Written on each verification; an account's entry leaves with the account.
 * Neither write throws.
 */
export const useVerifiedProfileCacheStore = create<VerifiedProfileCacheState>()(
  persist(
    (set) => ({
      profilesByUserId: {},
      remember: (userId, profile) => {
        bestEffort(() => {
          set((state) => ({
            profilesByUserId: { ...state.profilesByUserId, [userId]: profile },
          }));
        });
      },
      forget: (userId) => {
        bestEffort(() => {
          set((state) => {
            const { [userId]: _forgotten, ...rest } = state.profilesByUserId;
            return { profilesByUserId: rest };
          });
        });
      },
    }),
    {
      ...basePersistOptions(VERIFIED_PROFILE_CACHE_KEY),
      partialize: (state) => ({ profilesByUserId: state.profilesByUserId }),
    },
  ),
);

installCrossWindowRehydrate(
  useVerifiedProfileCacheStore,
  VERIFIED_PROFILE_CACHE_KEY,
);

export function readVerifiedProfile(userId: string): VerifiedProfile | null {
  const { profilesByUserId } = useVerifiedProfileCacheStore.getState();
  return Object.hasOwn(profilesByUserId, userId)
    ? profilesByUserId[userId]
    : null;
}
