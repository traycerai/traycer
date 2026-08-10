import { useEffect } from "react";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";

/**
 * Empty registry hygiene: with zero project profiles, a dangling active
 * profile id (stale id from a deleted registry) self-heals to All projects.
 *
 * Does NOT bounce draft routes: opening a draft under All projects is a
 * legitimate surface, and first-run redirect is prevented upstream by
 * `shouldRedirectHomeToDraft` (profileCount 0 ⇒ never auto-mint).
 */
export function EmptyProjectsHomeEnforcer(): null {
  const profileCount = useProjectProfilesStore((s) => s.profiles.length);
  const activeProfileId = useActiveProjectProfileStore(
    (s) => s.activeProfileId,
  );
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );

  useEffect(() => {
    if (profileCount > 0) return;
    if (activeProfileId !== null) {
      setActiveProfile(null);
    }
  }, [profileCount, activeProfileId, setActiveProfile]);

  return null;
}
