import { createElement, lazy } from "react";
import { History } from "lucide-react";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { historyTabIntent } from "@/lib/tab-navigation/intents";
import type { SystemTab, TabKindModule } from "@/stores/tabs/types";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const HISTORY_TAB_LABEL = "History";
const HISTORY_DEFAULT_PATH = "/epics";

const historySurface = lazy(() =>
  import("@/components/epics/history-surface").then((module) => ({
    default: module.HistorySurface,
  })),
);

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
    surface: {
      render: () => createElement(historySurface),
      canonicalRoute: (tab) => tab.route,
      splitEligibility: "eligible",
      duplication: "forbidden",
      singleton: "per-window",
      newWindow: "copy",
      readinessScope: "default-host",
      durableState: { owner: "tabs-store", eviction: "reconstruct" },
    },
    duplicate: () => null,
    resolveIntent: () => historyTabIntent(),
    routeOptions: () => ({ to: HISTORY_DEFAULT_PATH }),
    activate: () => {
      useLandingDraftStore.getState().clearActiveDraft();
    },
    requestClose: () => {
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "history",
        id: "history",
      });
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
