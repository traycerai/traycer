import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { AllProjectsHome } from "@/components/profiles/all-projects-home";
import { ProfileLaunchLanding } from "@/components/profiles/profile-launch-landing";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Root index route body.
 *
 * Signed-out users land on the auth-first desktop welcome surface. Once
 * authentication succeeds: "All projects" (no active profile) renders the
 * aggregate home; an active profile still uses ProfileLaunchLanding to jump
 * into its most recent epic (once per launch). The surrounding `LocalHostGate`
 * still blocks the composer until the desktop's local host is ready.
 */
export function RootLandingPage() {
  const status = useAuthStore((state) => state.status);
  const activeProfile = useActiveProjectProfile();

  if (status !== "signed-in") {
    return <AuthLandingPage />;
  }

  if (activeProfile === null) {
    return <AllProjectsHome />;
  }

  return <ProfileLaunchLanding />;
}
