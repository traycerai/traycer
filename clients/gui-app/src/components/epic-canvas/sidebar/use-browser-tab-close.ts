import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  findOpenTileInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

export interface BrowserTabCloseArgs {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly title: string;
  readonly status: BrowserTabInfo["status"];
  readonly onCloseTab: (sessionId: string, tabId: string) => Promise<void>;
}

export interface BrowserTabClose {
  /** The host is closing this tab, whether we asked or an agent did. */
  readonly isClosing: boolean;
  readonly close: () => void;
}

/**
 * Closing a browser tab from a list row: ask the host, then retire the tile the
 * row points at.
 *
 * The tile close is deliberately sequenced after the host's answer rather than
 * done optimistically - a refused close would otherwise leave the canvas with
 * no tile for a tab that is still open, and no row action that could bring it
 * back. A failure is reported and the row returns to its idle state; the
 * `closing` status the host reports in the meantime is folded in here so a
 * close an agent started reads the same as one this row started.
 */
export function useBrowserTabClose(args: BrowserTabCloseArgs): BrowserTabClose {
  const {
    epicId,
    viewTabId,
    hostId,
    sessionId,
    tabId,
    title,
    status,
    onCloseTab,
  } = args;
  const [closePending, setClosePending] = useState(false);
  const isClosing = status === "closing" || closePending;
  const tile = useMemo(
    () => makeBrowserSessionTileRef({ hostId, sessionId, tabId }),
    [hostId, sessionId, tabId],
  );
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareClose = useEpicCanvasStore(
    (state) => state.prepareCloseCanvasTabFocusTarget,
  );
  const close = useCallback(() => {
    if (isClosing) return;
    setClosePending(true);
    void onCloseTab(sessionId, tabId)
      .then(() => {
        const pointer = findOpenTileInTab(viewTabId, tile);
        if (pointer === null) return;
        navigateNested(epicId, viewTabId, () =>
          prepareClose(viewTabId, pointer.paneId, pointer.instanceId),
        );
      })
      .catch(() => {
        toast.error(`Couldn't close ${title}. Try again.`, {
          duration: Infinity,
        });
        setClosePending(false);
      });
  }, [
    epicId,
    isClosing,
    navigateNested,
    onCloseTab,
    prepareClose,
    sessionId,
    tabId,
    tile,
    title,
    viewTabId,
  ]);
  return { isClosing, close };
}

/**
 * The close button's label. A title shared by more than one row cannot identify
 * which tab the button closes, so those rows fall back to their disambiguating
 * label - or the tab id, which is unique by construction.
 */
export function browserTabCloseLabel(args: {
  readonly tabId: string;
  readonly title: string;
  readonly secondaryLabel: string | null;
  readonly isDuplicateTitle: boolean;
}): string {
  if (!args.isDuplicateTitle) return `Close ${args.title}`;
  return `Close ${args.title} (${args.secondaryLabel ?? args.tabId})`;
}
