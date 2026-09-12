import { createElement, lazy } from "react";
import { House } from "lucide-react";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { homeTabIntent } from "@/lib/tab-navigation/intents";
import type { HeaderTab, TabKindModule, TabRef } from "@/stores/tabs/types";

const HOME_TAB_LABEL = "Home";
const HOME_ROUTE = "/home";

/**
 * Home's ref, for the seams that are ref-addressed (navigation destinations,
 * activation results, the mobile header's surface resolution).
 *
 * It is deliberately NOT a layout ref: Home is never an entry in `items`, never
 * a `systemTab`, and never a source ref, so `repairLayout` rejects it (see
 * `validRef`) and `stripOrder` can never contain it. "Home is active" is
 * `activeItemId === null` in a layout whose Home tab is enabled - one state, not
 * a second item competing with the strip.
 */
export const HOME_TAB_REF: TabRef = { kind: "home", id: "home" };

const homeSurface = lazy(() =>
  import("@/components/home-focus/home-focus-view").then((module) => ({
    default: module.HomeFocusView,
  })),
);

/**
 * One record for the whole app rather than one per `build()` call: Home has no
 * source store to key a memo cache on, and the strip and the surface host both
 * compare it by identity.
 */
const HOME_HEADER_TAB: Extract<HeaderTab, { kind: "home" }> = {
  kind: "home",
  id: "home",
  route: HOME_ROUTE,
  name: HOME_TAB_LABEL,
  icon: House,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

/**
 * Module for `kind: "home"` tabs. A fixed singleton: it cannot be closed,
 * duplicated, moved, split, or opened in another window, so every behavior
 * below is either a refusal or the one route it owns.
 */
export const homeTabModule: TabKindModule<"home", null> = {
  kind: "home",
  build: () => HOME_HEADER_TAB,
  descriptor: {
    kind: "home",
    surface: {
      render: () => createElement(homeSurface),
      canonicalRoute: (tab) => tab.route,
      splitEligibility: "ineligible",
      duplication: "forbidden",
      singleton: "per-window",
      newWindow: "none",
      readinessScope: "none",
      durableState: { owner: "tabs-store", eviction: "reconstruct" },
    },
    duplicate: () => null,
    resolveIntent: () => homeTabIntent(),
    routeOptions: () => ({ to: HOME_ROUTE }),
    // Belt-and-braces: the activating transaction's own compatibility
    // projection already nulls `activeDraftId` whenever the focused ref is
    // null, which Home's always is. Kept so the kind states its own
    // post-condition rather than inheriting one, matching `history`.
    activate: () => {
      useLandingDraftStore.getState().clearActiveDraft();
    },
    // Refuses. Home is the surface every close lands ON; a close that could
    // remove it would leave the strip with nothing to fall back to.
    requestClose: () => undefined,
    requiresCloseConfirm: () => false,
    // Never offered - `canOpenInNewWindow` is false on the record above - so
    // this exists only to satisfy the exhaustive dispatch.
    openInNewWindow: () => undefined,
    matchesPath: (_tab, pathname) => isHomePath(pathname),
  },
};

/** The single Home `HeaderTab`, for consumers that render it structurally. */
export function homeHeaderTab(): Extract<HeaderTab, { kind: "home" }> {
  return HOME_HEADER_TAB;
}

export function homeRoutePath(): string {
  return HOME_ROUTE;
}

export function isHomePath(pathname: string): boolean {
  return pathname === HOME_ROUTE || pathname === `${HOME_ROUTE}/`;
}
