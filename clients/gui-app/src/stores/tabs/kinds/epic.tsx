import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  epicHasUnsyncedEdits,
  releaseOpenEpicSessionIfUnused,
} from "@/lib/registries/epic-session-registry";
import { epicPathname, epicTabRoute } from "@/lib/routes";
import { existingEpicTabIntent } from "@/lib/tab-navigation/intents";
import { duplicateEpicTab } from "@/lib/commands/actions/duplicate-tab";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import type { TabKindModule } from "@/stores/tabs/types";

/**
 * Module for `kind: "epic"` tabs. Data lives in the epic-canvas
 * store's `tabsById`; `build()` projects a `EpicViewTab` into the
 * flat `HeaderTab` variant. Close routes through the epic-canvas store
 * so visible header order and canvas restoration stay consistent.
 */
export const epicTabModule: TabKindModule<"epic", EpicViewTab> = {
  kind: "epic",
  build: (source) => ({
    kind: "epic",
    id: source.tabId,
    epicId: source.epicId,
    route: epicPathname({ tabId: source.tabId, epicId: source.epicId }),
    name: source.name,
    icon: null,
    canDuplicate: true,
    canOpenInNewWindow: true,
  }),
  descriptor: {
    kind: "epic",
    duplicate: (tab) => {
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
      search: intent.focus,
    }),
    activate: (intent) => {
      useLandingDraftStore.getState().clearActiveDraft();
      useEpicCanvasStore.getState().setActiveTab(intent.tabId);
    },
    requestClose: (tab) => {
      useEpicCanvasStore.getState().closeTab(tab.id);
      releaseOpenEpicSessionIfUnused(tab.epicId);
    },
    requiresCloseConfirm: (tab) => epicHasUnsyncedEdits(tab.epicId),
    openInNewWindow: (tab, deps) => {
      deps.epicFlow.requestOpenInNewWindow({
        epicId: tab.epicId,
        tabId: tab.id,
        title: tab.name,
      });
    },
    matchesPath: (tab, pathname) => pathname === tab.route,
  },
};
