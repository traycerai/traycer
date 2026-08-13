import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { buildProfileLandingEpicIntent } from "@/lib/profiles/profile-landing";
import { useActiveProjectProfile } from "@/lib/profiles/use-active-project-profile";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  draftTabIntent,
  existingEpicTabIntent,
  historyTabIntent,
  settingsTabIntent,
  type TabActivationIntent,
} from "@/lib/tab-navigation/intents";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistoryMembershipCacheStore } from "@/stores/profiles/history-membership-cache-store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

let launchLandingConsumed = false;

export function __resetProfileLaunchLandingForTesting(): void {
  launchLandingConsumed = false;
}

/**
 * Once per app launch: when the restored surface is the home route (this
 * component only mounts on `/`) and a project profile is active, jump
 * straight into the profile's most recent owned epic — the working surface.
 *
 * CRITICAL: this route sits in `route-adapter-layer`, which forces
 * `pointer-events: auto` on its child. A persistent spinner here covers the
 * retained tab host and makes the visible composer unclickable. Therefore:
 * - Show the spinner ONLY while we are still deciding the first jump.
 * - The moment the strip owns a tab (or we kick a draft/epic navigation),
 *   render `null` so pointer events fall through to the live surface.
 *
 * Semantics:
 * - Fires at most once per launch (module flag).
 * - Waits while the membership cache is cold (`hydrated === false`) so the
 *   landing target is computed from real data once the history query resolves.
 *   An empty-but-hydrated cache (new profile, zero epics) is NOT cold — we
 *   open a draft instead of a black void.
 * - Launch passes `openEpicIds: null` deliberately: at cold start, jumping to
 *   the most recent owned epic IS the "continue where you left off" feature.
 * - Empty-strip fallback: mint a draft via `activateTabIntent` (not `/draft/new`
 *   route bounce) so orphan drafts from other profiles cannot block minting.
 * - Non-empty strip on `/`: AppShell hides TopLevelTabHost on the landing
 *   route. After a profile swap that restores tabs then `navigateHome`s (or
 *   lands on `/` already), leaving `/` without activating the focused strip
 *   tab paints a black void. Activate that tab so the keep-alive host can
 *   paint. A restored strip wins over the once-per-launch epic jump.
 */
export function ProfileLaunchLanding(): ReactNode {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activeProfile = useActiveProjectProfile();
  const itemsByEpicId = useHistoryMembershipCacheStore((s) => s.itemsByEpicId);
  const membershipHydrated = useHistoryMembershipCacheStore((s) => s.hydrated);
  const stripLen = useTabsStore((s) => s.stripOrder.length);
  // Re-run when canvas sources land so a restored epic chip can resolve.
  const canvasTabCount = useEpicCanvasStore(
    (s) => Object.keys(s.tabsById).length,
  );
  const jumpPendingRef = useRef(false);
  // Ref alone does not re-render; pair with state so the click-blocking spinner
  // unmounts the moment we kick a draft/epic navigation.
  const [surfaceReleased, setSurfaceReleased] = useState(false);

  const releaseSurface = (): void => {
    jumpPendingRef.current = true;
    setSurfaceReleased(true);
  };

  useEffect(() => {
    // All projects owns `/` — never bounce to a draft from the null profile.
    if (activeProfile === null) {
      launchLandingConsumed = true;
      return;
    }
    if (pathname !== "/") return;
    if (jumpPendingRef.current) return;

    if (stripLen > 0) {
      // Profile-restored strip on `/`: leave landing so TopLevelTabHost paints.
      // Unresolved epic (canvas still hydrating) waits — do NOT mint a draft
      // over an existing strip (profile-switch race / ghost chip).
      const intent = intentForFocusedStripItem();
      if (intent === null) return;
      launchLandingConsumed = true;
      releaseSurface();
      activateTabIntent(navigate, intent, { replace: true });
      return;
    }

    if (!launchLandingConsumed) {
      if (!membershipHydrated) {
        // Cache cold: keep waiting — do not mint a draft that would race the
        // eventual epic jump once history arrives.
        return;
      }
      const intent = buildProfileLandingEpicIntent(
        activeProfile,
        Array.from(itemsByEpicId.values()),
        null,
      );
      launchLandingConsumed = true;
      if (intent !== null) {
        releaseSurface();
        activateTabIntent(navigate, intent, { replace: true });
        return;
      }
    }

    // Still waiting on history for the once-per-launch epic jump.
    if (!launchLandingConsumed && !membershipHydrated) return;
    // Empty project home: mint a draft composer directly under the tab host.
    releaseSurface();
    activateTabIntent(navigate, openNewEpicIntent(), { replace: true });
  }, [
    activeProfile,
    canvasTabCount,
    itemsByEpicId,
    membershipHydrated,
    navigate,
    pathname,
    stripLen,
  ]);

  // Live strip / kickoff in flight → get out of the way. The route-adapter
  // layer turns any child into a full-window click interceptor.
  if (stripLen > 0 || surfaceReleased || jumpPendingRef.current) {
    return null;
  }

  // Waiting on membership for the first-launch epic decision only.
  if (!membershipHydrated && !launchLandingConsumed) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <AgentSpinningDots
          className={undefined}
          testId="profile-launch-landing-spinner"
          variant={undefined}
        />
      </div>
    );
  }

  return null;
}

/**
 * Map the focused (or first) strip ref to an activation intent. Returns null
 * when the focused epic tab is not yet in the canvas (source still hydrating).
 */
export function intentForFocusedStripItem(): TabActivationIntent | null {
  const state = useTabsStore.getState();
  const focused = selectHostFocusedRef(state);
  const ref: TabRef | null = focused ?? state.stripOrder[0] ?? null;
  if (ref === null) return null;
  return intentForStripRef(ref);
}

function intentForStripRef(ref: TabRef): TabActivationIntent | null {
  switch (ref.kind) {
    case "draft":
      return draftTabIntent(ref.id);
    case "history":
      return historyTabIntent();
    case "settings":
      return settingsTabIntent("general");
    case "epic": {
      const epic = useEpicCanvasStore.getState().tabsById[ref.id];
      if (epic === undefined) return null;
      return existingEpicTabIntent({
        epicId: epic.epicId,
        tabId: epic.tabId,
        focus: undefined,
      });
    }
  }
}
