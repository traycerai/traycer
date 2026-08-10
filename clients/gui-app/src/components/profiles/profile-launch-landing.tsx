import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { buildProfileLandingEpicIntent } from "@/lib/profiles/profile-landing";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";
import { activateTabIntent } from "@/lib/tab-navigation";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { useTabsStore } from "@/stores/tabs/store";

let launchLandingConsumed = false;

export function __resetProfileLaunchLandingForTesting(): void {
  launchLandingConsumed = false;
}

/**
 * Once per app launch: when the restored surface is the home route (this
 * component only mounts on `/`) and a project profile is active, jump
 * straight into the profile's most recent owned epic — the working surface.
 *
 * Semantics:
 * - Fires at most once per launch (module flag).
 * - Waits while the membership cache is cold (empty map) so the landing
 *   target is computed from real data once the history query resolves.
 * - Launch passes `openEpicIds: null` deliberately: at cold start, jumping to
 *   the most recent owned epic IS the "continue where you left off" feature.
 *   The closed-tab-stays-closed strip authority applies to PROFILE SWITCHING
 *   (see project-profile-switcher), where reopening a just-closed tab is a
 *   bug, not a convenience.
 *
 * Empty-strip fallback (active profile only): when a profile is active and
 * the strip is EMPTY, standing on `/` would show a black void, so we go to a
 * fresh draft — the locked composer is the project's home. "All projects"
 * (activeProfile === null) owns `/` as the aggregate home and never redirects.
 * Other guards:
 * - Only from the `/` pathname: a failed `/draft/new` resolution re-renders
 *   this component (see DraftNewRoute) and must never re-fire the redirect.
 * - Never while a launch jump is queued in this mount (tab-navigation may
 *   hold activation until hydration; a later cache update must not clobber
 *   the queued epic with a draft).
 * - A non-empty strip means a live tab owns the surface; leave it alone.
 *   The strip read MUST be reactive: on a profile switch the bridge swaps the
 *   bucket asynchronously around the same render pass, so a one-shot
 *   `getState()` read can still see the OUTGOING profile's tabs, bail out,
 *   and never re-run — a permanent black screen (observed live: switching
 *   into a profile whose bucket is empty).
 */
export function ProfileLaunchLanding(): ReactNode {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeProfile = useActiveProjectProfile();
  const itemsByEpicId = useHistoryMembershipCacheStore((s) => s.itemsByEpicId);
  const stripLen = useTabsStore((s) => s.stripOrder.length);
  const jumpPendingRef = useRef(false);

  useEffect(() => {
    if (!launchLandingConsumed) {
      if (activeProfile === null) {
        launchLandingConsumed = true;
      } else if (itemsByEpicId.size === 0) {
        // Cache cold: the launch jump is still pending — no draft fallback
        // yet, or a warm cache's epic would lose the race to a fresh draft.
        return;
      } else {
        const intent = buildProfileLandingEpicIntent(
          activeProfile,
          Array.from(itemsByEpicId.values()),
          null,
        );
        launchLandingConsumed = true;
        if (intent !== null) {
          jumpPendingRef.current = true;
          // replace: the skipped Start Page stays out of Back history.
          activateTabIntent(navigate, intent, { replace: true });
          return;
        }
      }
    }
    // All projects owns `/` — never bounce to a draft from the null profile.
    if (activeProfile === null) return;
    if (pathname !== "/") return;
    if (jumpPendingRef.current) return;
    if (stripLen > 0) return;
    navigate({ to: "/draft/new", replace: true });
  }, [activeProfile, itemsByEpicId, navigate, pathname, stripLen]);

  return null;
}
