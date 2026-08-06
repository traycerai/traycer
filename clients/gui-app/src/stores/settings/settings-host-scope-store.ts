import { create } from "zustand";

/**
 * WHICH HOST SETTINGS IS ADMINISTERING — and nothing else.
 *
 * This is deliberately NOT the app-wide active host. The two answer different
 * questions and merging them is the defect this store exists to prevent:
 *
 *   - **Viewing** (this store): which machine's Providers / Worktrees /
 *     Notifications / snapshots am I looking at and editing? Cheap, reversible,
 *     no effect outside Settings.
 *   - **Active for this window** (`HostDirectoryService.selectById`, read
 *     through `useReactiveActiveHostId`): which machine does this window talk
 *     to for ambient work — notification indicators, the bell, rate limits,
 *     the resource monitor, and where newly started work lands. Consequential.
 *
 * Before this store each panel kept its own `useState`, so walking from
 * Providers to Worktrees silently reset the scope back to the active host and
 * the user had to re-pick. One store means one selection for the whole
 * Settings session.
 *
 * NOT persisted, on purpose. A viewing scope that survived a relaunch would
 * silently leave someone administering a machine they last touched days ago —
 * the reverse of the visibility problem this whole surface is fixing. It
 * resets to "follow the active host" on every app start.
 */
interface SettingsHostScopeState {
  /**
   * `null` means "follow the active host" — not "no host". Keeping the
   * unset case distinct from a pinned selection is what lets a single-host
   * user never see a stale id after their only host is re-registered.
   */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
}

export const useSettingsHostScopeStore = create<SettingsHostScopeState>(
  (set) => ({
    scopedHostId: null,
    setScopedHostId: (hostId) => set({ scopedHostId: hostId }),
  }),
);
