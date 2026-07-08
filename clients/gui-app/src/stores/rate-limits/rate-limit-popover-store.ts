import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * The Overview tab, one tab per connected host-RPC provider, and - when the
 * account is eligible - the GUI-sourced "traycer" tab. `"traycer"` is a
 * synthetic entry: it is NOT a `RateLimitProviderId` and does not flow through
 * `useConfiguredRateLimitProviders()`.
 */
export type RateLimitPopoverTab = "overview" | RateLimitProviderId | "traycer";

interface RateLimitPopoverStoreState {
  readonly activeTab: RateLimitPopoverTab;
  readonly setActiveTab: (tab: RateLimitPopoverTab) => void;
}

const RATE_LIMIT_POPOVER_PERSIST_KEY = persistKey(STORE_KEYS.rateLimitPopover);

function persistedActiveTab(persistedState: unknown): RateLimitPopoverTab {
  if (typeof persistedState !== "object" || persistedState === null) {
    return "overview";
  }
  if (!("activeTab" in persistedState)) return "overview";
  const activeTab = persistedState.activeTab;
  if (activeTab === "overview" || activeTab === "traycer") return activeTab;
  const result = rateLimitCapableProviderIdSchema.safeParse(activeTab);
  return result.success ? result.data : "overview";
}

export const useRateLimitPopoverStore = create<RateLimitPopoverStoreState>()(
  persist(
    (set, get) => ({
      activeTab: "overview",
      setActiveTab: (activeTab) => {
        if (get().activeTab === activeTab) return;
        set({ activeTab });
      },
    }),
    {
      ...basePersistOptions(RATE_LIMIT_POPOVER_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        activeTab: persistedActiveTab(persistedState),
      }),
      partialize: (state) => ({
        activeTab: state.activeTab,
      }),
    },
  ),
);
