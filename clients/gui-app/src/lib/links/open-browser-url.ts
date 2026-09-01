import { useCallback } from "react";
import { toast } from "sonner";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { electronTabBinding } from "@/lib/browser-view/sessions/electron-tab-directory";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useOpenExternalLink } from "@/lib/links/open-external-link";
import { hashOf, samePageKey } from "@/lib/links/normalize-url";
import type {
  TileOpenIntent,
  TileOpenModifiers,
  TileOpenTarget,
} from "@/lib/canvas/tile-open/intent";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";

export interface OpenBrowserUrlInput {
  readonly url: string;
  readonly modifiers: TileOpenModifiers;
  readonly epicId: string;
  /** The canvas tab the click came from, or `null` off a canvas. */
  readonly viewTabId: string | null;
}

interface MatchedTab {
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
}

/**
 * Opens a URL in a browser tile on this epic's host (A4, B1, B4).
 *
 * A tab already showing the same page is focused instead of opening a second
 * one - that is what keeps repeated link clicks from stacking tabs and splits
 * (P2). Middle-click bypasses the match on purpose: it means "another one, in
 * the background" (B4).
 *
 * A failure NEVER falls out to the OS browser on its own (A5). The user gets
 * the reason and an explicit "Open in browser" action, because silently
 * sending a link somewhere else is indistinguishable from the setting not
 * working.
 */
export function useOpenBrowserUrl(): (input: OpenBrowserUrlInput) => void {
  const sessions = useMaybeBrowserSessionsContext();
  const { openTile } = useEpicTileNavigation();
  const openExternalLink = useOpenExternalLink();

  return useCallback(
    (input: OpenBrowserUrlInput): void => {
      const failed = (reason: string): void => {
        toast.error(reason, {
          action: {
            label: "Open in browser",
            onClick: () => openExternalLink(input.url),
          },
        });
      };
      const hostId = sessions?.hostId ?? null;
      if (
        sessions === null ||
        sessions.lifecycle !== "live" ||
        hostId === null
      ) {
        failed("Browsers aren't connected on this host yet.");
        return;
      }

      const target: TileOpenTarget =
        input.viewTabId === null
          ? { epicId: input.epicId }
          : { tabId: input.viewTabId };
      const open = (tab: { sessionId: string; tabId: string }): void => {
        openTile(
          browserTileIntent({
            hostId,
            sessionId: tab.sessionId,
            tabId: tab.tabId,
            target,
            modifiers: input.modifiers,
          }),
        );
      };

      const match = input.modifiers.middle
        ? null
        : findSamePageTab(sessions.items, input.url);
      if (match !== null) {
        open(match);
        if (hashOf(match.url) !== hashOf(input.url)) {
          navigateTab(hostId, match, input.url);
        }
        return;
      }

      sessions
        .openTab(null, input.url)
        .then(open)
        .catch((cause: unknown) => {
          failed(
            cause instanceof Error
              ? cause.message
              : "Couldn't open a browser tab.",
          );
        });
    },
    [openExternalLink, openTile, sessions],
  );
}

function browserTileIntent(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly target: TileOpenTarget;
  readonly modifiers: TileOpenModifiers;
}): TileOpenIntent {
  return {
    node: makeBrowserSessionTileRef({
      hostId: args.hostId,
      sessionId: args.sessionId,
      tabId: args.tabId,
    }),
    target: args.target,
    // A link click is one click, so it previews like every other single click
    // (C4/C11); `middle` in the modifiers is what turns it into a background
    // open.
    gesture: "single",
    modifiers: args.modifiers,
    placement: null,
    dedupe: true,
    source: "direct_ui",
  };
}

/** The first live tab on this host showing the same page (B4). */
function findSamePageTab(
  items: readonly BrowserSessionInfo[],
  url: string,
): MatchedTab | null {
  const key = samePageKey(url);
  if (key === null) return null;
  for (const session of items) {
    for (const tab of session.tabs) {
      if (tab.status === "closing" || tab.status === "crashed") continue;
      if (samePageKey(tab.url) !== key) continue;
      return { sessionId: session.sessionId, tabId: tab.tabId, url: tab.url };
    }
  }
  return null;
}

/**
 * Same page, different fragment: move the tab we just focused rather than
 * leaving the user on the anchor they came from (B4).
 *
 * ponytail: Electron tabs only - a headless tab is navigated through the
 * screencast control stream, which needs an armed control session on a
 * mounted tile. Upgrade path is a `navigateTab` frame on `browser.sessions`;
 * until then a headless tab keeps its current fragment.
 */
function navigateTab(hostId: string, tab: MatchedTab, url: string): void {
  const binding = electronTabBinding(hostId, tab.sessionId, tab.tabId);
  if (binding === null) return;
  void binding.control({ kind: "navigate", url }).catch(ignoreError);
}
