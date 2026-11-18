import { createContext, use, useLayoutEffect } from "react";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

/**
 * What a joined box hands the bridge that runs it onto its sheet: the pane it
 * joins, and the colour its outline is drawn in. `outline` is `null` for the
 * sheets' own border (`--canvas-border`); a coloured header tab passes its
 * colour, so the bridge's sides and feet continue the tab's coloured outline
 * rather than switching to the sheets' border halfway down its silhouette.
 */
export interface SheetJoin {
  readonly pane: SheetJoinPane;
  readonly outline: string | null;
}

type PublishJoin = (join: SheetJoin) => () => void;
export const PublishJoinContext = createContext<PublishJoin | null>(null);
export const JoinContext = createContext<SheetJoin | null>(null);

// Two primitives rather than one `SheetJoin`: an object would be a fresh
// dependency every render, unpublishing and republishing in a loop.
export function usePublishSheetJoin(
  pane: SheetJoinPane | null,
  outline: string | null,
): void {
  const publish = use(PublishJoinContext);
  useLayoutEffect(() => {
    if (pane === null || publish === null) return;
    return publish({ pane, outline });
  }, [pane, outline, publish]);
}
