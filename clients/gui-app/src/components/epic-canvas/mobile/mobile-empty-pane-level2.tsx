import type { ReactNode } from "react";
import { MobileTabSwitcherMount } from "@/components/epic-canvas/mobile/mobile-tab-switcher-mount";
import { MobileTileColumn } from "@/components/epic-canvas/mobile/mobile-tile-column";
import { MobileTileMenu } from "@/components/epic-canvas/mobile/mobile-tile-menu";
import { useMobileTileLevel2Form } from "@/components/epic-canvas/mobile/use-mobile-tile-level2-form";
import { MobileLevel2MenuTrigger } from "@/components/layout/shell/mobile-level2";

/**
 * Level 2 around a task with no tile on screen. The list is how the person gets
 * a tile back, so every form still offers it; the menu has no tile's name to sit
 * under and is named for what it does.
 */
export function MobileEmptyPaneLevel2(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { epicId, tabId, children } = props;
  const level2 = useMobileTileLevel2Form();
  if (level2 === "bar") {
    return (
      <>
        {children}
        <MobileTabSwitcherMount epicId={epicId} tabId={tabId} />
      </>
    );
  }
  return (
    <div className="flex h-full min-h-0 w-full bg-canvas">
      <MobileTileColumn epicId={epicId} tabId={tabId} level2={level2} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {level2 === "menu" ? (
          <MobileTileMenu epicId={epicId} tabId={tabId} drawn>
            <div
              data-mobile-shell-touch-scope=""
              className="flex min-h-11 shrink-0 items-center border-b border-canvas-border/70 px-3"
            >
              <MobileLevel2MenuTrigger
                testId="mobile-tile-menu-trigger"
                className={undefined}
              >
                Switch tab
              </MobileLevel2MenuTrigger>
            </div>
          </MobileTileMenu>
        ) : null}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      <MobileTabSwitcherMount epicId={epicId} tabId={tabId} />
    </div>
  );
}
