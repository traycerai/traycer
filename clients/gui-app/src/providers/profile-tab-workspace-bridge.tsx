import { useEffect, useMemo, type ReactNode } from "react";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import type { AppRouter } from "@/router";
import { profileOwnsEpic } from "@/lib/profiles/profile-membership";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import {
  ALL_PROJECTS_TAB_BUCKET,
  profileTabBucket,
  useProfileTabWorkspacesStore,
} from "@/stores/profiles/profile-tab-workspaces-store";
import {
  emptyTabStripLayout,
  flattenLayoutRefs,
  tabRefKey,
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
/** Minimal route seam for the controller (imperative, router-free in tests). */
export interface ProfileTabRouteSource {
  readonly pathname: () => string;
  readonly navigateHome: () => void;
}

export function ProfileTabWorkspaceBridge(props: {
  readonly router: AppRouter;
}): ReactNode {
  const route = useMemo<ProfileTabRouteSource>(
    () => ({
      pathname: () => props.router.state.location.pathname,
      navigateHome: () => {
        void props.router.navigate({ to: "/", replace: true });
      },
    }),
    [props.router],
  );
  return <ProfileTabWorkspaceBridgeCore route={route} />;
}

export function ProfileTabWorkspaceBridgeCore(props: {
  readonly route: ProfileTabRouteSource;
}): ReactNode {
  const windowsHydrated = useWindowsBridgeHydrated();

  useEffect(() => {
    if (!windowsHydrated) return;
    return startProfileTabWorkspaceController(props.route);
  }, [windowsHydrated, props.route]);

  return null;
}

/**
 * Installs profile-switch + write-through subscriptions. Exported for tests
 * so they can drive the controller without mounting the full provider tree.
 * Returns a disposer.
 */
export function startProfileTabWorkspaceController(
  route: ProfileTabRouteSource,
): () => void {
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
    releaseForeignActiveRoute(bucket, layout);
  };

  /**
   * After a swap, the live route must not pin a tab the incoming profile does
   * not own — an open /epics/<id> or /draft/<id> route re-materializes its tab
   * on the next route commit and leaks it into the freshly restored strip.
   * Epic routes release home unless the epic is KNOWN to belong to the
   * incoming profile (unknown membership fails open: keep the user's context).
   * Draft routes release only when the draft is not part of the restored
   * strip. Switching to "all-projects" never releases.
   */
  const releaseForeignActiveRoute = (
    bucket: string,
    restoredLayout: PersistedTabStripLayout,
  ): void => {
    if (bucket === ALL_PROJECTS_TAB_BUCKET) return;
    const pathname = route.pathname();
    const epicMatch = pathname.match(/^\/epics\/([^/]+)/);
    if (epicMatch !== null) {
      const epicId = epicMatch[1];
      const profiles = useProjectProfilesStore.getState().profiles;
      const incoming = profiles.find((p) => profileTabBucket(p.id) === bucket);
      if (incoming === undefined) return;
      const item = useHistoryMembershipCacheStore
        .getState()
        .itemsByEpicId.get(epicId);
      if (item === undefined) return; // unknown membership → keep context
      if (profileOwnsEpic(incoming, epicId, item.linkedWorkspaces)) return;
      route.navigateHome();
      return;
    }
    const draftMatch = pathname.match(/^\/draft\/([^/]+)/);
    if (draftMatch !== null) {
      const draftKey = tabRefKey({ kind: "draft", id: draftMatch[1] });
      const restoredKeys = new Set(
        flattenLayoutRefs(restoredLayout).map(tabRefKey),
      );
      if (!restoredKeys.has(draftKey)) route.navigateHome();
    }
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
