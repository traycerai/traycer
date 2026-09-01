import { useState } from "react";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  browserTabOrigin,
  nextSettledTabIdentity,
  type SettledTabIdentity,
} from "@/lib/browser-view/browser-tab-display";

export type BrowserTabPresentation = SettledTabIdentity & {
  readonly isolated: boolean;
};

function settleBrowserTabPresentation(
  previous: BrowserTabPresentation | null,
  tab: BrowserTabInfo,
  isolated: boolean,
): BrowserTabPresentation {
  const identity = nextSettledTabIdentity(previous, tab);
  return {
    ...identity,
    faviconUrl:
      browserTabOrigin(tab.url) === browserTabOrigin(identity.url)
        ? identity.faviconUrl
        : null,
    isolated,
  };
}

export function useBrowserTabPresentation(
  tab: EpicCanvasTileRef,
): BrowserTabPresentation | null {
  const sessions = useMaybeBrowserSessionsContext();
  const session =
    tab.type === "browser-session"
      ? sessions?.items.find(
          (candidate) =>
            candidate.hostId === tab.hostId &&
            candidate.sessionId === tab.sessionId,
        )
      : undefined;
  const liveTab =
    tab.type === "browser-session"
      ? session?.tabs.find((candidate) => candidate.tabId === tab.tabId)
      : undefined;
  const [state, setState] = useState(() => ({
    liveTab,
    presentation:
      liveTab === undefined || session === undefined
        ? null
        : settleBrowserTabPresentation(
            null,
            liveTab,
            session.profile === "isolated",
          ),
  }));
  if (state.liveTab === liveTab) return state.presentation;
  const presentation =
    liveTab === undefined || session === undefined
      ? null
      : settleBrowserTabPresentation(
          state.presentation,
          liveTab,
          session.profile === "isolated",
        );
  setState({ liveTab, presentation });
  return presentation;
}
