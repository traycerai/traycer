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
  /**
   * Which host's usage this surface is READING — never which host the window
   * runs on. Picking here swaps a transient client and nothing else, exactly
   * like the Settings sidebar switcher (`settings-host-scope-store.ts`); where
   * new work lands is still `HostDirectoryService.selectById`'s answer alone.
   *
   * `null` means "follow the active host", which is not the same as "no host":
   * keeping the unset case distinct is what lets a single-host user never see
   * a stale id after their only host is re-registered.
   *
   * Unlike the Settings viewing scope this one IS persisted, and the reason the
   * two differ is what each scope can do. Settings is an administration surface
   * whose scope aims destructive verbs, so a pick that outlived a relaunch
   * would point them at a machine last touched days ago. This surface only
   * READS usage, and someone who watches one machine's limits wants that same
   * machine on the next launch rather than a pick they must redo every time.
   * A pick that no longer resolves is still never substituted silently — it
   * surfaces as `vanished`/`unreachable` with a way back to the active host.
   */
  readonly scopedHostId: string | null;
  readonly setActiveTab: (tab: RateLimitPopoverTab) => void;
  readonly setSize: (size: RateLimitPopoverSize | null) => void;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
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

/**
 * A host id is opaque to this layer, so the only checkable claim is "a
 * non-empty string someone could have picked". Whether it still names a host
 * this client can reach is `resolveScopedHost`'s question, answered against
 * the live host lists rather than guessed at rehydration time.
 */
function persistedScopedHostId(persistedState: unknown): string | null {
  if (typeof persistedState !== "object" || persistedState === null) {
    return null;
  }
  if (!("scopedHostId" in persistedState)) return null;
  const scopedHostId = persistedState.scopedHostId;
  if (typeof scopedHostId !== "string" || scopedHostId.length === 0) {
    return null;
  }
  return scopedHostId;
}

export const useRateLimitPopoverStore = create<RateLimitPopoverStoreState>()(
  persist(
    (set, get) => ({
      activeTab: "overview",
      size: null,
      scopedHostId: null,
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
      setScopedHostId: (scopedHostId) => {
        if (get().scopedHostId === scopedHostId) return;
        set({ scopedHostId });
      },
    }),
    {
      ...basePersistOptions(RATE_LIMIT_POPOVER_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        activeTab: persistedActiveTab(persistedState),
        size: persistedSize(persistedState),
        scopedHostId: persistedScopedHostId(persistedState),
      }),
      partialize: (state) => ({
        activeTab: state.activeTab,
        size: state.size,
        scopedHostId: state.scopedHostId,
      }),
    },
  ),
);
