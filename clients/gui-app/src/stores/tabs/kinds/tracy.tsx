import { createElement, lazy } from "react";
import { Bot } from "lucide-react";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { isTracyPath, tracyPathname, tracyRoute } from "@/lib/routes";
import type { TabKindModule, TabRef } from "@/stores/tabs/types";
import { TAB_KIND_SPLIT_ELIGIBILITY } from "@/stores/tabs/tab-kind-policy";

const tracySurface = lazy(() =>
  import("@/components/bots/bot-tab-surface").then((module) => ({
    default: module.BotTabSurface,
  })),
);

/** The strip's name for the surface, whichever channel it shows (decision 82). */
export const TRACY_TAB_LABEL = "Tracy";

/** The surface's one ref: there is one Tracy surface per window. */
export const TRACY_TAB_REF: TabRef = { kind: "tracy", id: "tracy" };

/** What the surface store says while the surface is open. */
export interface TracySurfaceSource {
  readonly hostId: string;
  readonly botId: string | null;
}

/**
 * Module for the `kind: "tracy"` tab (decision 150): the one Tracy surface
 * of a window, a singleton backed by the surface store, which says whether it
 * exists, the host it is bound to and the channel selected. Its path is the
 * selected channel's `/bot/{botId}`, or `/bot` with none, and every `/bot`
 * path is the surface's, so a channel switch keeps the tab and moves only
 * its path. The surface wraps itself in `TabHostProvider` with the store's
 * host, so everything under it addresses that host and never the app-wide
 * one.
 *
 * Not duplicable and not openable in another window: a second window would
 * need the surface's host handed across, which this kind has no flow for.
 * Closing closes the surface; no bot is touched.
 */
export const tracyTabModule: TabKindModule<"tracy", TracySurfaceSource> = {
  kind: "tracy",
  build: (source) => ({
    kind: "tracy",
    id: "tracy",
    hostId: source.hostId,
    botId: source.botId,
    route: tracyPathname(source.botId),
    name: TRACY_TAB_LABEL,
    icon: Bot,
    canDuplicate: false,
    canOpenInNewWindow: false,
    appearance: null,
  }),
  descriptor: {
    kind: "tracy",
    surface: {
      render: (tab) =>
        createElement(tracySurface, { botId: tab.botId, hostId: tab.hostId }),
      canonicalRoute: (tab) => tab.route,
      splitEligibility: TAB_KIND_SPLIT_ELIGIBILITY.tracy,
      duplication: "forbidden",
      singleton: "per-window",
      newWindow: "none",
      readinessScope: "tab-host",
      durableState: { owner: "tracy-surface", eviction: "reconstruct" },
    },
    duplicate: () => null,
    resolveIntent: (tab) => ({ kind: "tracy", botId: tab.botId }),
    routeOptions: (intent) => tracyRoute(intent.botId),
    activate: () => undefined,
    requestClose: (_tab, close) => {
      close(TRACY_TAB_REF);
    },
    requiresCloseConfirm: () => false,
    openInNewWindow: () => undefined,
    matchesPath: (_tab, pathname) => isTracyPath(pathname),
  },
};

/** Whether the surface is open - the kind's source check. */
export function isTracySurfaceOpen(): boolean {
  return useTracySurfaceStore.getState().open;
}
