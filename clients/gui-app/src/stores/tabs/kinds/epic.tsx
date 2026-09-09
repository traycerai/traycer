import { createElement, lazy } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { epicHasUnsyncedEdits } from "@/lib/registries/epic-session-registry";
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
 * `build()`'s input: the epic-canvas source record plus the `hostId` the
 * caller already resolved. `hostId` is NOT re-derived in here from
 * `getEpicSessionHostId` - it is a projection of the open-epic registry, and
 * `useHeaderTabForRef` / `useHeaderTabs`' projection already subscribe to
 * that registry via `useSyncExternalStore` so they re-render on a session
 * re-point. Reading it a second time inside `build()` would create a second,
 * unsubscribed source for the same fact: correct the instant `build()` runs,
 * stale the moment the session re-points without also touching this
 * `EpicViewTab`. One caller resolves it, `build()` only stamps it.
 */
interface EpicTabBuildSource {
  readonly view: EpicViewTab;
  readonly hostId: string | null;
}

/**
 * Module for `kind: "epic"` tabs. Data lives in the epic-canvas
 * store's `tabsById`; `build()` projects a `EpicViewTab` into the
 * flat `HeaderTab` variant. Close routes through the epic-canvas store
 * so visible header order and canvas restoration stay consistent.
 */
export const epicTabModule: TabKindModule<"epic", EpicTabBuildSource> = {
  kind: "epic",
  build: ({ view: source, hostId }) => {
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
      hostId,
      route: epicPathname({ tabId: source.tabId, epicId: source.epicId }),
      name: source.name,
      icon: null,
      canClose: !closeLocked,
      canDuplicate: !structurallyLocked,
      canOpenInNewWindow: !structurallyLocked,
      repositoryIdentity: null,
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
