import { createFileRoute, redirect } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
import { admitsLocalPlane } from "@/stores/auth/auth-store";

export const Route = createFileRoute("/")({
  // Sends an admitted user with no restored tabs to a fresh draft. In Electron
  // the stores this reads are only authoritative after the windows-bridge
  // snapshot has hydrated; `beforeLoad` runs on preload and cannot await that,
  // so a stale-empty read here may over-redirect to `/draft/new`. That is safe:
  // `DraftNewRoute` gates the actual draft creation on hydration and re-checks
  // `hasRestoredTabs()` before minting (see draft-new-route-components.tsx).
  //
  // SURFACE, and this one is a dead end rather than a slow path if left on the
  // verdict. `RootLandingPage` renders `AuthLandingPage` only for a session
  // `admitsLocalPlane` REFUSES; an admitted one renders `null` and relies on
  // this redirect for somewhere to be. So an `unverified` user with no restored
  // tabs used to land inside the app shell with an empty outlet - no composer,
  // no draft, nothing. A draft is minted locally against the host and `/draft`
  // itself admits the same predicate (`requireSignedIn`), so there is no cloud
  // capability behind this at all.
  beforeLoad: ({ context }) => {
    if (!admitsLocalPlane(context.getAuthSnapshot().status)) return;
    if (hasRestoredTabs()) return;
    redirect({ to: "/draft/new", replace: true, throw: true });
  },
  component: RootLandingPage,
});
