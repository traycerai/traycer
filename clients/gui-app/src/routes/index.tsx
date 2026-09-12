import { createFileRoute, redirect } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
import { admitsLocalPlane } from "@/stores/auth/auth-store";
import { isHomeTabEnabled } from "@/stores/settings/settings-store";

export const Route = createFileRoute("/")({
  // Sends an admitted user with no restored tabs onward - to Home where the
  // Home tab is on, and to a fresh draft otherwise. In Electron
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
  // capability behind this at all. Home is a local-plane surface on the same
  // footing, so it answers that dead end for an `unverified` session too.
  beforeLoad: ({ context }) => {
    if (!admitsLocalPlane(context.getAuthSnapshot().status)) return;
    if (hasRestoredTabs()) return;
    // With the Home tab on, a window with nothing restored opens on Home rather
    // than on a freshly minted draft. Still behind `hasRestoredTabs()`, and for
    // the reason that guard has always existed: the phone shell boots its
    // WebView at `/` with a full layout restored behind it, so a redirect that
    // fired there would land on Home every relaunch and throw away the tab the
    // user actually left open.
    if (isHomeTabEnabled()) {
      redirect({ to: "/home", replace: true, throw: true });
    }
    redirect({ to: "/draft/new", replace: true, throw: true });
  },
  component: RootLandingPage,
});
