import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { buildProfileLandingEpicIntent } from "@/lib/profiles/profile-landing";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";
import { activateTabIntent } from "@/lib/tab-navigation";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";

let launchLandingConsumed = false;

export function __resetProfileLaunchLandingForTesting(): void {
  launchLandingConsumed = false;
}

/**
 * Once per app launch: when the restored surface is the home/Start Page (this
 * component only mounts on the `/` route) and a project profile is active,
 * jump straight into the profile's most recent owned epic — the working
 * surface — instead of sitting on the greeting screen.
 *
 * Semantics:
 * - Fires at most once per launch (module flag); deliberate later visits to
 *   the Start Page are never redirected.
 * - Waits while the membership cache is cold (empty map) so the landing
 *   target is computed from real data once the history query resolves.
 * - No profile active, or profile owns no epic → consumes and stays home.
 * - The activation goes through the tab-navigation controller, which queues
 *   until tab hydration is ready, so launch timing races are safe.
 */
export function ProfileLaunchLanding(): ReactNode {
  const navigate = useNavigate();
  const activeProfile = useActiveProjectProfile();
  const itemsByEpicId = useHistoryMembershipCacheStore((s) => s.itemsByEpicId);

  useEffect(() => {
    if (launchLandingConsumed) return;
    if (activeProfile === null) {
      launchLandingConsumed = true;
      return;
    }
    if (itemsByEpicId.size === 0) return;
    const intent = buildProfileLandingEpicIntent(
      activeProfile,
      Array.from(itemsByEpicId.values()),
    );
    launchLandingConsumed = true;
    if (intent !== null) {
      // replace: the skipped Start Page stays out of Back history.
      activateTabIntent(navigate, intent, { replace: true });
    }
  }, [activeProfile, itemsByEpicId, navigate]);

  return null;
}
