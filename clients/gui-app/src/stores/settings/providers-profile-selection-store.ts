import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { profileCommitId } from "@/components/providers/provider-profile-model";

/**
 * Per-`(hostId, providerId)` remembered profile selection for Settings ▸
 * Providers' profile switcher (D25: "Selection remembered GUI-locally per
 * `(hostId, providerId)`, invalid → Default account"). Nested `hostId →
 * providerId → commit id` rather than a composed `"${hostId}:${providerId}"`
 * string key — a host id may contain `:` (see the gui-app AGENTS.md
 * host-scoped-store rules on `worktreeStagingKeyString`), and nesting removes
 * the delimiter question instead of encoding around it.
 *
 * `hostId === null` drops the write (mirrors
 * `composer-harness-memory-store.ts`'s `record`): there is no host to
 * remember a selection against.
 */
interface ProvidersProfileSelectionStore {
  /** hostId → providerId → commit id (`null` = Default account). */
  readonly selectedByHost: Readonly<
    Record<string, Readonly<Record<string, string | null>>>
  >;
  readonly setSelected: (
    hostId: string | null,
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
}

export const useProvidersProfileSelectionStore =
  create<ProvidersProfileSelectionStore>()(
    persist(
      (set) => ({
        selectedByHost: {},
        setSelected: (hostId, providerId, profileId) => {
          if (hostId === null) return;
          set((state) => {
            const forHost = state.selectedByHost[hostId] ?? {};
            return {
              selectedByHost: {
                ...state.selectedByHost,
                [hostId]: { ...forHost, [providerId]: profileId },
              },
            };
          });
        },
      }),
      {
        ...basePersistOptions(persistKey(STORE_KEYS.providersProfileSelection)),
        partialize: (state) => ({ selectedByHost: state.selectedByHost }),
      },
    ),
  );

/**
 * D25's "invalid → Default account" fallback: a remembered commit id that no
 * longer names a profile the host reports resolves to Default account
 * (`null`) rather than sticking to a stale id. Exported standalone so the
 * fallback rule can be driven without mounting the switcher.
 */
export function resolveSelectedProfileId(
  remembered: string | null | undefined,
  profiles: readonly ProviderProfile[],
): string | null {
  if (remembered === undefined || remembered === null) return null;
  const stillPresent = profiles.some(
    (profile) => profileCommitId(profile) === remembered,
  );
  return stillPresent ? remembered : null;
}
