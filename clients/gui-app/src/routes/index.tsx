import { createFileRoute, redirect } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";

export const Route = createFileRoute("/")({
  // Sends a signed-in user with no restored tabs to a fresh draft. In Electron
  // the stores this reads are only authoritative after the windows-bridge
  // snapshot has hydrated; `beforeLoad` runs on preload and cannot await that,
  // so a stale-empty read here may over-redirect to `/draft/new`. That is safe:
  // `DraftNewRoute` gates the actual draft creation on hydration and re-checks
  // `hasRestoredTabs()` before minting (see draft-new-route-components.tsx).
  beforeLoad: ({ context }) => {
    if (context.getAuthSnapshot().status !== "signed-in") return;
    if (hasRestoredTabs()) return;
    redirect({ to: "/draft/new", replace: true, throw: true });
  },
  component: RootLandingPage,
});
