import { createElement, lazy } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  epicHasUnsyncedEdits,
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { buildNestedFocusSearchPatch } from "@/lib/epic-nested-focus-route";
import { epicPathname, epicTabRoute } from "@/lib/routes";
import { existingEpicTabIntent } from "@/lib/tab-navigation/intents";
import { duplicateEpicTab } from "@/lib/commands/actions/duplicate-tab";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import type { TabKindModule } from "@/stores/tabs/types";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  isTabCloseLocked,
  isTabStructurallyLocked,
} from "@/stores/tabs/tab-structural-lock";

const epicSurface = lazy(() =>
  import("@/components/epic-tabs/epic-surface").then((module) => ({
    default: module.EpicSurface,
  })),
);

/**
 * The host serving this epic right now, read from the live session rather
 * than stored on the tab.
 *
 * The session provider owns the answer (`requestedHostId ?? effectiveHostId`,
 * stamped onto the handle at acquire); this reads it. `null` when the registry
 * holds no handle - a background tab evicted past the MRU cap, or any tab
 * before the provider's first acquisition, including the window between the
 * registry's own emit for that acquisition and the handle being stamped.
 * Every one of those degrades a consumer to the app-wide client, which is what
 * it used before this projection existed - a safe direction, and the reason
 * this can be a plain read instead of an ordering contract.
 */
function epicSessionHostId(epicId: string): string | null {
  const handle = getOpenEpicRegistry().peek(epicId);
  return handle === null ? null : getEpicSessionHandleHostId(handle);
}

/**
 * Module for `kind: "epic"` tabs. Data lives in the epic-canvas
 * store's `tabsById`; `build()` projects a `EpicViewTab` into the
 * flat `HeaderTab` variant. Close routes through the epic-canvas store
 * so visible header order and canvas restoration stay consistent.
 */
export const epicTabModule: TabKindModule<"epic", EpicViewTab> = {
  kind: "epic",
  build: (source) => {
    const closeLocked = isTabCloseLocked({
      kind: "epic",
      id: source.tabId,
    });
    const structurallyLocked = isTabStructurallyLocked({
      kind: "epic",
      id: source.tabId,
    });
    return {
      kind: "epic",
      id: source.tabId,
      epicId: source.epicId,
      hostId: epicSessionHostId(source.epicId),
      route: epicPathname({ tabId: source.tabId, epicId: source.epicId }),
      name: source.name,
      icon: null,
      canClose: !closeLocked,
      canDuplicate: !structurallyLocked,
      canOpenInNewWindow: !structurallyLocked,
    };
  },
  descriptor: {
    kind: "epic",
    surface: {
      render: (tab) =>
        createElement(epicSurface, { epicId: tab.epicId, tabId: tab.id }),
      canonicalRoute: (tab) => tab.route,
      splitEligibility: "eligible",
      duplication: "allowed",
      singleton: "per-instance",
      newWindow: "move",
      // T11 adds a durable per-Epic host binding. Until then the session
      // provider resolves through the renderer default host, so readiness must
      // use that same scope rather than inventing a tile-derived binding.
      readinessScope: "default-host",
      durableState: { owner: "epic-canvas", eviction: "reconstruct" },
    },
    duplicate: (tab) => {
      if (isTabStructurallyLocked({ kind: "epic", id: tab.id })) return null;
      const duplicated = duplicateEpicTab(tab.id);
      if (duplicated === null) return null;
      return existingEpicTabIntent({
        epicId: duplicated.epicId,
        tabId: duplicated.tabId,
        focus: undefined,
      });
    },
    resolveIntent: (tab) =>
      existingEpicTabIntent({
        epicId: tab.epicId,
        tabId: tab.id,
        focus: undefined,
      }),
    routeOptions: (intent) => ({
      ...epicTabRoute({ epicId: intent.epicId, tabId: intent.tabId }),
      // `nestedFocus` is `null` for every plain tab-switch intent, in which
      // case `buildNestedFocusSearchPatch` contributes `undefined` for both
      // fields - identical to the old `search: intent.focus` literal, so
      // wipe-then-canonicalize behavior is unchanged for ordinary switches.
      // Only `existingEpicTabIntentWithNestedFocus` (cross-route openers)
      // sets a real target, committing it in this same navigation.
      search: {
        ...intent.focus,
        ...buildNestedFocusSearchPatch(intent.nestedFocus),
      },
    }),
    activate: (intent) => {
      useLandingDraftStore.getState().clearActiveDraft();
      useEpicCanvasStore.getState().setActiveTab(intent.tabId);
    },
    requestClose: (tab) => {
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "epic",
        id: tab.id,
      });
    },
    requiresCloseConfirm: (tab) => epicHasUnsyncedEdits(tab.epicId),
    openInNewWindow: (tab, deps) => {
      if (isTabStructurallyLocked({ kind: "epic", id: tab.id })) return;
      deps.epicFlow.requestOpenInNewWindow({
        epicId: tab.epicId,
        tabId: tab.id,
        title: tab.name,
      });
    },
    matchesPath: (tab, pathname) => pathname === tab.route,
  },
};
