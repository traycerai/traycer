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

interface RateLimitPopoverSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

interface RateLimitPopoverStoreState {
  readonly activeTab: RateLimitPopoverTab;
  readonly size: RateLimitPopoverSize | null;
  readonly setActiveTab: (tab: RateLimitPopoverTab) => void;
  readonly setSize: (size: RateLimitPopoverSize | null) => void;
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

function persistedSize(persistedState: unknown): RateLimitPopoverSize | null {
  if (typeof persistedState !== "object" || persistedState === null)
    return null;
  if (!("size" in persistedState)) return null;
  const size = persistedState.size;
  if (typeof size !== "object" || size === null) return null;
  if (!("widthPx" in size) || !("heightPx" in size)) return null;
  const { widthPx, heightPx } = size;
  if (
    typeof widthPx !== "number" ||
    !Number.isFinite(widthPx) ||
    widthPx <= 0 ||
    typeof heightPx !== "number" ||
    !Number.isFinite(heightPx) ||
    heightPx <= 0
  ) {
    return null;
  }
  return { widthPx, heightPx };
}

export const useRateLimitPopoverStore = create<RateLimitPopoverStoreState>()(
  persist(
    (set, get) => ({
      activeTab: "overview",
      size: null,
      setActiveTab: (activeTab) => {
        if (get().activeTab === activeTab) return;
        set({ activeTab });
      },
      setSize: (size) => {
        const currentSize = get().size;
        if (
          currentSize?.widthPx === size?.widthPx &&
          currentSize?.heightPx === size?.heightPx
        ) {
          return;
        }
        set({ size });
      },
    }),
    {
      ...basePersistOptions(RATE_LIMIT_POPOVER_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        activeTab: persistedActiveTab(persistedState),
        size: persistedSize(persistedState),
      }),
      partialize: (state) => ({
        activeTab: state.activeTab,
        size: state.size,
      }),
    },
  ),
);
