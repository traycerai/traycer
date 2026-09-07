import { createFileRoute, redirect } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";

export const Route = createFileRoute("/")({
  // Signed-in with no restored tabs -> /draft/new. beforeLoad cannot await
  // hydration; DraftNewRoute re-checks hasRestoredTabs() before minting.
  beforeLoad: ({ context }) => {
    if (context.getAuthSnapshot().status !== "signed-in") return;
    if (hasRestoredTabs()) return;
    redirect({ to: "/draft/new", replace: true, throw: true });
  },
  component: RootLandingPage,
});
