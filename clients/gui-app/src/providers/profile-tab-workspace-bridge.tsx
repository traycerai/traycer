import { useEffect, type ReactNode } from "react";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import {
  profileTabBucket,
  useProfileTabWorkspacesStore,
} from "@/stores/profiles/profile-tab-workspaces-store";
import {
  emptyTabStripLayout,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { readTabStripLayout, useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

/** Matches desktop-tabs-persistence write debounce. */
const DEBOUNCE_MS = 100;

/**
 * Swaps the live tab strip when the active project profile changes.
 *
 * v1 multi-window limitation: profile tab buckets are a single global map
 * (account-scoped localStorage). Concurrent windows last-writer-win; there is
 * no per-window isolation of profile tab workspaces.
 *
 * Hydration: never swap until the windows-bridge gate flips true. A pre-
 * hydration strip is often empty localStorage residue and would clobber the
 * real bucket for the active profile.
 */
export function ProfileTabWorkspaceBridge(): ReactNode {
  const windowsHydrated = useWindowsBridgeHydrated();

  useEffect(() => {
    if (!windowsHydrated) return;
    return startProfileTabWorkspaceController();
  }, [windowsHydrated]);

  return null;
}

/**
 * Installs profile-switch + write-through subscriptions. Exported for tests
 * so they can drive the controller without mounting the full provider tree.
 * Returns a disposer.
 */
export function startProfileTabWorkspaceController(): () => void {
  let disposed = false;
  let swapping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeBucket = profileTabBucket(
    useActiveProjectProfileStore.getState().activeProfileId,
  );

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const saveActiveBucket = (): void => {
    if (disposed || swapping) return;
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout(activeBucket, readTabStripLayout());
  };

  const scheduleWriteThrough = (): void => {
    if (disposed || swapping) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      saveActiveBucket();
    }, DEBOUNCE_MS);
  };

  const restoreBucket = (bucket: string): void => {
    const saved =
      useProfileTabWorkspacesStore.getState().layoutsByBucket[bucket];
    const layout: PersistedTabStripLayout =
      saved !== undefined ? saved : emptyTabStripLayout();
    tabCommandCoordinator.restoreHydratedLayout(layout);
  };

  const swapToProfile = (nextProfileId: string | null): void => {
    if (disposed) return;
    const nextBucket = profileTabBucket(nextProfileId);
    if (nextBucket === activeBucket) return;

    // Flush any pending write-through for the outgoing bucket first.
    clearTimer();
    swapping = true;
    try {
      useProfileTabWorkspacesStore
        .getState()
        .saveLayout(activeBucket, readTabStripLayout());
      restoreBucket(nextBucket);
      activeBucket = nextBucket;
    } finally {
      swapping = false;
    }
  };

  const unsubscribeProfile = useActiveProjectProfileStore.subscribe(
    (state, previous) => {
      if (state.activeProfileId === previous.activeProfileId) return;
      swapToProfile(state.activeProfileId);
    },
  );

  const unsubscribeTabs = useTabsStore.subscribe((state, previous) => {
    if (
      state.items !== previous.items ||
      state.activeItemId !== previous.activeItemId ||
      state.activationHistory !== previous.activationHistory ||
      state.systemTabs !== previous.systemTabs
    ) {
      scheduleWriteThrough();
    }
  });

  return () => {
    disposed = true;
    clearTimer();
    unsubscribeProfile();
    unsubscribeTabs();
  };
}
