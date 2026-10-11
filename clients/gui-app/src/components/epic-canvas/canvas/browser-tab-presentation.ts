import { useState } from "react";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import { useBrowserSessionsSelectorForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  browserTabOrigin,
  nextSettledTabIdentity,
  type SettledTabIdentity,
} from "@/lib/browser-view/browser-tab-display";

export type BrowserTabPresentation = SettledTabIdentity & {
  readonly isolated: boolean;
};

interface BrowserTabDisplay {
  readonly liveTab: BrowserTabInfo;
  readonly isolated: boolean;
}

function browserTabDisplayEqual(
  a: BrowserTabDisplay | null,
  b: BrowserTabDisplay | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.isolated === b.isolated &&
      a.liveTab.tabId === b.liveTab.tabId &&
      a.liveTab.title === b.liveTab.title &&
      a.liveTab.url === b.liveTab.url &&
      a.liveTab.status === b.liveTab.status)
  );
}

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
  epicId: string,
): BrowserTabPresentation | null {
  const display = useBrowserSessionsSelectorForHost(
    {
      hostId: tab.type === "browser-session" ? tab.hostId : null,
      scope: { kind: "epic", epicId },
    },
    (sessions) => {
      if (tab.type !== "browser-session") return null;
      const session = sessions.items.find(
        (candidate) =>
          candidate.hostId === tab.hostId &&
          candidate.sessionId === tab.sessionId,
      );
      const liveTab = session?.tabs.find(
        (candidate) => candidate.tabId === tab.tabId,
      );
      return session === undefined || liveTab === undefined
        ? null
        : { liveTab, isolated: session.profile === "isolated" };
    },
    browserTabDisplayEqual,
  );
  const [state, setState] = useState(() => ({
    display,
    presentation:
      display === null
        ? null
        : settleBrowserTabPresentation(null, display.liveTab, display.isolated),
  }));
  if (browserTabDisplayEqual(state.display, display)) return state.presentation;
  const presentation =
    display === null
      ? null
      : settleBrowserTabPresentation(
          state.presentation,
          display.liveTab,
          display.isolated,
        );
  setState({ display, presentation });
  return presentation;
}
