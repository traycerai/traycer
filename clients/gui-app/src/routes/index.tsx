import { createFileRoute, redirect } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
import { shouldRedirectHomeToDraft } from "@/lib/profiles/home-route-decision";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";

export const Route = createFileRoute("/")({
  // Sends a signed-in user with an active profile and no restored tabs to a
  // fresh draft. Zero profiles or "All projects" (activeProfileId === null)
  // keeps `/` so the empty / aggregate home can render.
  beforeLoad: ({ context }) => {
    if (context.getAuthSnapshot().status !== "signed-in") return;
    const activeProfileId =
      useActiveProjectProfileStore.getState().activeProfileId;
    const profileCount = useProjectProfilesStore.getState().profiles.length;
    if (
      !shouldRedirectHomeToDraft(
        hasRestoredTabs(),
        activeProfileId,
        profileCount,
      )
    ) {
      return;
    }
    redirect({ to: "/draft/new", replace: true, throw: true });
  },
  component: RootLandingPage,
});
