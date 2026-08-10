import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { profileOwnsEpic } from "@/lib/profiles/profile-membership";
import type { AppRouter } from "@/router";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";

export interface ProfileAutoSwitchBridgeProps {
  /**
   * Live app router. This bridge mounts above `<RouterProvider>` (next to
   * `EpicTabExistenceReconciler`), so pathname is read imperatively — same
   * pattern as `SupportContextRegistryBridge` / `HistoryPruneProvider`.
   */
  readonly router: AppRouter;
}

/**
 * When the user opens an epic that belongs to exactly one project profile,
 * auto-switch the active project to that profile (with a toast). Fail-open
 * when membership is unknown, multi-profile, or none.
 *
 * Membership comes from the host-free history membership cache (populated by
 * `useHistoryQuery`).
 */
export function ProfileAutoSwitchBridge(
  props: ProfileAutoSwitchBridgeProps,
): ReactNode {
  const pathname = useRouterPathname(props.router);
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const activeProfileId = useActiveProjectProfileStore(
    (s) => s.activeProfileId,
  );
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );
  const itemsByEpicId = useHistoryMembershipCacheStore((s) => s.itemsByEpicId);
  const handledEpicIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const match = pathname.match(/^\/epics\/([^/]+)/);
    if (match === null) return;
    const epicId = match[1];
    if (handledEpicIdsRef.current.has(epicId)) return;
    handledEpicIdsRef.current.add(epicId);

    const item = itemsByEpicId.get(epicId);
    if (item === undefined) return;

    const owners = profiles.filter((profile) =>
      profileOwnsEpic(profile, epicId, item.linkedWorkspaces),
    );
    if (owners.length !== 1) return;
    const owner = owners[0];
    if (owner.id === activeProfileId) return;

    setActiveProfile(owner.id);
    toast.info(`Switched to project "${owner.name}"`);
  }, [activeProfileId, itemsByEpicId, pathname, profiles, setActiveProfile]);

  return null;
}

function useRouterPathname(router: AppRouter): string {
  const subscribe = useCallback(
    (callback: () => void) =>
      router.subscribe("onResolved", () => {
        callback();
      }),
    [router],
  );
  const getSnapshot = useCallback(
    () => router.state.location.pathname,
    [router],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => "");
}
