import { History } from "lucide-react";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { historyTabIntent } from "@/lib/tab-navigation/intents";
import type { SystemTab, TabKindModule } from "@/stores/tabs/types";

const HISTORY_TAB_LABEL = "History";
const HISTORY_DEFAULT_PATH = "/epics";

/**
 * Module for `kind: "history"` tabs. Singleton; no duplication.
 * Route is always `/epics` regardless of last visited sub-path.
 */
export const historyTabModule: TabKindModule<"history", SystemTab> = {
  kind: "history",
  build: (source) => ({
    kind: "history",
    id: "history",
    route: HISTORY_DEFAULT_PATH,
    name: source.name.length > 0 ? source.name : HISTORY_TAB_LABEL,
    icon: History,
    canDuplicate: false,
    canOpenInNewWindow: true,
    lastPath: source.lastPath,
  }),
  descriptor: {
    kind: "history",
    duplicate: () => null,
    resolveIntent: () => historyTabIntent(),
    routeOptions: () => ({ to: HISTORY_DEFAULT_PATH }),
    activate: () => {
      useLandingDraftStore.getState().clearActiveDraft();
    },
    requestClose: () => {
      useTabsStore.getState().closeSystemTab("history");
    },
    requiresCloseConfirm: () => false,
    openInNewWindow: (tab, deps) => {
      void deps.bridge.requestNew(tab.route);
    },
    matchesPath: (_tab, pathname) => isHistoryPath(pathname),
  },
};
export function defaultHistoryTabName(): string {
  return HISTORY_TAB_LABEL;
}

export function historyDefaultPath(): string {
  return HISTORY_DEFAULT_PATH;
}

export function isHistoryPath(pathname: string): boolean {
  return pathname === "/epics" || pathname === "/epics/";
}
