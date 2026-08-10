import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";

/**
 * First-run / empty registry: always land on All projects home.
 * Clears a stale active profile id and bounces away from draft mint routes.
 */
export function EmptyProjectsHomeEnforcer(): null {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const profileCount = useProjectProfilesStore((s) => s.profiles.length);
  const activeProfileId = useActiveProjectProfileStore((s) => s.activeProfileId);
  const setActiveProfile = useActiveProjectProfileStore(
    (s) => s.setActiveProfile,
  );

  useEffect(() => {
    if (profileCount > 0) return;

    if (activeProfileId !== null) {
      setActiveProfile(null);
    }

    if (
      pathname === "/draft/new" ||
      pathname.startsWith("/draft/") ||
      pathname === "/onboarding"
    ) {
      void navigate({ to: "/", replace: true });
    }
  }, [
    profileCount,
    activeProfileId,
    setActiveProfile,
    pathname,
    navigate,
  ]);

  return null;
}
