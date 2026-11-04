import type { ReactNode } from "react";
import { MobileTabSwitcherMount } from "@/components/epic-canvas/mobile/mobile-tab-switcher-mount";
import { MobileTileChooserPane } from "@/components/epic-canvas/mobile/mobile-tile-chooser-pane";
import { useMobileTileListForm } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";

/**
 * Level 2 around a task with no tile on screen. On a phone the opener in
 * `children` draws, with the sheet behind the header's trigger to get a tile
 * back from; everywhere wider the list fills the pane itself, as it does in a
 * pane a Split opened, and the pick is what ends it.
 */
export function MobileEmptyPaneLevel2(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { epicId, tabId, children } = props;
  if (useMobileTileListForm(tabId) === "bar") {
    return (
      <>
        {children}
        <MobileTabSwitcherMount epicId={epicId} tabId={tabId} />
      </>
    );
  }
  return (
    <MobileTileChooserPane
      epicId={epicId}
      tabId={tabId}
      slot="primary"
      onClose={null}
    />
  );
}
