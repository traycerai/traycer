import { useEffect, type ReactNode } from "react";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { HostLifecycleSettingsSection } from "@/components/settings/host-lifecycle-settings-section";
import { GENERAL } from "@/components/settings/panels/general-settings.definitions";
import { useShellLocalPlaneAdmission } from "@/hooks/auth/use-shell-local-plane-admission";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { openShellSettings } from "@/lib/commands/actions/open-shell-settings";

/**
 * `/when-you-quit`: the one setting a signed-out desktop can reach.
 *
 * Signed out there is no settings shell. `/settings` renders the sign-in page,
 * and the tab host that would open Settings is not mounted. What the host on
 * this machine does when Traycer quits is still a desktop-main preference
 * that needs no account, so the desktop's "Settings…" (native menu, tray,
 * jump list) lands here while the shell is not admitted. The route renders
 * that card and nothing else: no settings nav, no app shell, no link onward.
 * Signing in is the sign-in page's job, reached the ordinary way.
 *
 * Admitted, the route has no body of its own. It hands off to Settings ▸
 * General through the activation the admitted command uses
 * (`openShellSettings`), so a sign-in that lands while this is open ends
 * exactly where "Settings…" would have. A surface without the card - the
 * phone, a runner host with no lifecycle bridge - goes to `/`.
 */
export function WhenYouQuitRoute(): ReactNode {
  const admission = useShellLocalPlaneAdmission();
  const availability = useSettingsAvailabilityContext();
  if (!GENERAL.definitions.hostLifecycle.availableWhen(availability)) {
    return <Navigate to="/" replace />;
  }
  if (admission.admitted) return <AdmittedSettingsHandOff />;
  return (
    // Inside `StandaloneShell`, the one full-bleed surface: it takes the
    // viewport rather than sitting in `#root`'s reservation, so this content
    // layer restores all four insets itself.
    <div
      data-testid="signed-out-quit-settings"
      className="flex min-h-full w-full justify-center pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
    >
      <div className="w-full max-w-3xl p-6">
        <HostLifecycleSettingsSection />
      </div>
    </div>
  );
}

function AdmittedSettingsHandOff(): ReactNode {
  const navigate = useNavigate();
  // Router ↔ tab-store sync: the tab controller owns where Settings opens, and
  // it queues this until the window's tabs have hydrated. It replaces this
  // entry, since `/when-you-quit` has nothing to show an admitted shell.
  useEffect(() => {
    openShellSettings(navigate, { replace: true });
  }, [navigate]);
  return null;
}
