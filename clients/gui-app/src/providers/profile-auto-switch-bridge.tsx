import { useEffect, useRef, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useHistoryQuery } from "@/hooks/home/use-history-query";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { profileOwnsWorkspaceRefs } from "@/lib/profiles/profile-membership";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";

/**
 * When the user opens an epic that belongs to exactly one project profile,
 * auto-switch the active project to that profile (with a toast). Fail-open
 * when membership is unknown, multi-profile, or none.
 */
export function ProfileAutoSwitchBridge(): ReactNode {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const activeProfileId = useActiveProjectProfileStore(
    (s) => s.activeProfileId,
  );
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );
  const history = useHistoryQuery({
    search: DEFAULT_HISTORY_SEARCH,
    nowMs: null,
  });
  const handledEpicIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const match = pathname.match(/^\/epics\/([^/]+)/);
    if (match === null) return;
    const epicId = match[1];
    if (handledEpicIdsRef.current.has(epicId)) return;
    handledEpicIdsRef.current.add(epicId);

    const membershipItems = history.data?.membershipItems ?? [];
    const item = membershipItems.find((row) => row.epicId === epicId);
    if (item === undefined) return;

    const owners = profiles.filter((profile) =>
      profileOwnsWorkspaceRefs(profile, item.linkedWorkspaces),
    );
    if (owners.length !== 1) return;
    const owner = owners[0];
    if (owner.id === activeProfileId) return;

    setActiveProfile(owner.id);
    toast.info(`Switched to project "${owner.name}"`);
  }, [
    activeProfileId,
    history.data?.membershipItems,
    pathname,
    profiles,
    setActiveProfile,
  ]);

  return null;
}
