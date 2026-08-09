import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import type { ProjectProfile } from "./types";

/** The active profile, or null for "All projects". Self-heals a dangling id. */
export function useActiveProjectProfile(): ProjectProfile | null {
  const activeId = useActiveProjectProfileStore((s) => s.activeProfileId);
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );
  const profile = profiles.find((p) => p.id === activeId) ?? null;
  if (activeId !== null && profile === null) {
    // Profile was deleted under us — fall back to All projects (render-phase
    // setState into zustand is safe: it's an external store, not React state).
    setActiveProfile(null);
    return null;
  }
  return profile;
}
