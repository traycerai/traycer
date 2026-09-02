import { useCallback } from "react";
import { toast } from "sonner";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  useMaybeBrowserSessionsSnapshot,
  type BrowserSessionsSnapshot,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";

export interface OpenBrowserUrlInput {
  readonly url: string;
  readonly modifiers: TileOpenModifiers;
  readonly epicId: string;
  /** The canvas tab the click came from. */
  readonly viewTabId: string;
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
  // Read at CLICK time, not subscribed: this hook is mounted by every link
  // surface in the app and the sessions context is a fresh object per stream
  // frame (C8).
  const snapshot = useMaybeBrowserSessionsSnapshot();
  const { openTile } = useEpicTileNavigation();
  const { mutateAsync: openExternal } = useOpenExternalLink();

  return useCallback(
    (input: OpenBrowserUrlInput): void => {
      const sessions = sessionsOf(snapshot);
      const failed = (reason: string): void => {
        toast.error(reason, {
          action: {
            label: "Open in browser",
            onClick: () => {
              void openExternal(input.url).catch(ignoreError);
            },
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

      const open = (tab: { sessionId: string; tabId: string }): void => {
        openTile(
          browserTileIntent({
            hostId,
            sessionId: tab.sessionId,
            tabId: tab.tabId,
            // Resolved HERE rather than before the `openTab` await: the header
            // tab can close while the open is in flight, and opening into a
            // closed tab id mutates a canvas with no route (R8).
            target: currentTarget(input),
            modifiers: input.modifiers,
          }),
        );
      };

      const match = input.modifiers.middle
        ? null
        : findSamePageTab(hostId, sessions.items, input.url);
      if (match !== null) {
        open(match);
        if (hashOf(match.url) !== hashOf(input.url)) {
          navigateTab(hostId, match, input.url);
        }
        return;
      }

      openTabOnce(sessions, hostId, input)
        .then(open)
        .catch((cause: unknown) => {
          failed(
            cause instanceof Error
              ? cause.message
              : "Couldn't open a browser tab.",
          );
        });
    },
    [openExternal, openTile, snapshot],
  );
}

/**
 * `openTab` requests that have not settled yet, keyed by host + page (B4).
 *
 * The snapshot only learns about a new tab when the session frame lands, so
 * two clicks on the same link inside that window would each see no match and
 * mint their own host tab - and, holding different tab ids, defeat the tile
 * dedupe as well. Joining the outstanding request makes the second click
 * focus what the first one opened.
 */
const openTabsInFlight = new Map<
  string,
  Promise<{ readonly sessionId: string; readonly tabId: string }>
>();

function openTabOnce(
  sessions: BrowserSessionsState,
  hostId: string,
  input: OpenBrowserUrlInput,
): Promise<{ readonly sessionId: string; readonly tabId: string }> {
  const pageKey = samePageKey(input.url);
  // Middle-click means "another one" (B4), so it never joins and never
  // registers - the next plain click must not be answered with its tab.
  if (input.modifiers.middle || pageKey === null) {
    return sessions.openTab(null, input.url);
  }
  const key = `${hostId}\u0000${pageKey}`;
  const joined = openTabsInFlight.get(key);
  if (joined !== undefined) return joined;
  const request = sessions.openTab(null, input.url);
  openTabsInFlight.set(key, request);
  const forget = (): void => {
    if (openTabsInFlight.get(key) === request) openTabsInFlight.delete(key);
  };
  // `then(forget, forget)`, not `finally`: this arm HANDLES the rejection, so
  // the cleanup does not float a second unhandled copy of the caller's error.
  void request.then(forget, forget);
  return request;
}

/**
 * Deref through a plain function, not inline: React Compiler reads a
 * `.current` access inside a `useCallback` as a ref dependency and then
 * refuses to preserve the manual memo. Passing the ref object to a function
 * keeps the callback's dependency the (stable) snapshot itself, which is the
 * whole point of reading sessions at click time (C8).
 */
function sessionsOf(
  snapshot: BrowserSessionsSnapshot | null,
): BrowserSessionsState | null {
  return snapshot?.current ?? null;
}

/**
 * The click's own canvas tab while it still exists, else the epic - which lets
 * the resolver pick (or create) a live tab instead.
 */
function currentTarget(input: OpenBrowserUrlInput): TileOpenTarget {
  const tabs = useEpicCanvasStore.getState().tabsById;
  return tabs[input.viewTabId] === undefined
    ? { epicId: input.epicId }
    : { tabId: input.viewTabId };
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
  hostId: string,
  items: readonly BrowserSessionInfo[],
  url: string,
): MatchedTab | null {
  const key = samePageKey(url);
  if (key === null) return null;
  const hash = hashOf(url);
  for (const session of items) {
    for (const tab of session.tabs) {
      if (tab.status === "closing" || tab.status === "crashed") continue;
      if (samePageKey(tab.url) !== key) continue;
      // Same page, different fragment, and no way to move it there: focusing
      // this tab would land the user on the anchor they came FROM, so let the
      // click open a fresh tab at the fragment it asked for instead
      // (see {@link navigateTab} for which tabs can be moved).
      if (
        hashOf(tab.url) !== hash &&
        electronTabBinding(hostId, session.sessionId, tab.tabId) === null
      ) {
        continue;
      }
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
 * mounted tile. A headless tab on another fragment is therefore not matched
 * at all ({@link findSamePageTab}) and the click opens a fresh tab; the
 * upgrade path is a `navigateTab` frame on `browser.sessions`, after which
 * that tab can be reused like an Electron one.
 */
function navigateTab(hostId: string, tab: MatchedTab, url: string): void {
  const binding = electronTabBinding(hostId, tab.sessionId, tab.tabId);
  if (binding === null) return;
  void binding.control({ kind: "navigate", url }).catch(ignoreError);
}
