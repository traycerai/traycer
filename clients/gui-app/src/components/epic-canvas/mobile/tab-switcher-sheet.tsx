import { useCallback } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SwitcherCategoryTabs } from "@/components/epic-canvas/mobile/switcher-category-tabs";
import {
  MOBILE_SWITCHER_CATEGORY_DEFS,
  clampToSwitcherCategory,
  isSwitcherCategory,
} from "@/components/epic-canvas/mobile/switcher-categories";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import { useIsMobile } from "@/hooks/ui/use-mobile";
import {
  useActiveLeftPanelId,
  useLeftPanelStore,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface TabSwitcherSheetProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The mobile "Switch tab" bottom sheet (the screenshot-2 surface). A
 * drag-dismissable `vaul` drawer whose category bar mirrors the desktop
 * left-panel registry and whose content region shows the active category's
 * body. Foundation ticket (P2.1): the bar + shell + category persistence ship
 * here; the per-category bodies are placeholders that P2.2 (flat lists) and P2.3
 * (panel embeds) replace in place.
 *
 * Opened from the Phase-1 current-tile bar chevron. Only meaningful on phones -
 * it is mounted from `MobileEpicTileView`, which itself renders only under the
 * `useIsMobile()` canvas branch - and self-gates on `useIsMobile()` as defence.
 */
export function TabSwitcherSheet(props: TabSwitcherSheetProps) {
  const { epicId, tabId, open, onOpenChange } = props;
  const isMobile = useIsMobile();
  const persistedCategory = useActiveLeftPanelId(tabId);
  const setActivePanelId = useLeftPanelStore((s) => s.setActivePanelId);
  const activeCategory = clampToSwitcherCategory(persistedCategory);

  const handleCategoryChange = useCallback(
    (value: string) => {
      // Persist through the SAME desktop left-panel store so mobile and desktop
      // stay in sync; ignore any value outside the curated set defensively.
      if (isSwitcherCategory(value)) setActivePanelId(tabId, value);
    },
    [setActivePanelId, tabId],
  );

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  if (!isMobile) return null;

  return (
    <Drawer direction="bottom" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="mobile-tab-switcher-sheet"
        className="max-h-[min(90dvh,44rem)]"
      >
        <DrawerHeader className="pb-2">
          <DrawerTitle>Switch tab</DrawerTitle>
        </DrawerHeader>
        <Tabs
          value={activeCategory}
          onValueChange={handleCategoryChange}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 border-b border-canvas-border/70">
            <SwitcherCategoryTabs />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            {MOBILE_SWITCHER_CATEGORY_DEFS.map((definition) => (
              <TabsContent key={definition.id} value={definition.id}>
                <SwitcherCategoryBody
                  categoryId={definition.id}
                  epicId={epicId}
                  tabId={tabId}
                  onClose={handleClose}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}

interface SwitcherCategoryBodyProps {
  readonly categoryId: LeftPanelId;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Content-region registry. The `chats`/`terminals`/`artifacts` categories are
 * flat lists (P2.2); `file-tree`/`git-diff` remain placeholders until P2.3
 * embeds the desktop panel bodies. `onClose` closes the sheet after a selection
 * so the chosen item becomes the full-screen mobile tile.
 */
function SwitcherCategoryBody(props: SwitcherCategoryBodyProps) {
  const { categoryId, epicId, tabId, onClose } = props;
  switch (categoryId) {
    case "chats":
      return <SwitcherAgentsList epicId={epicId} tabId={tabId} onClose={onClose} />;
    case "terminals":
      return (
        <SwitcherTerminalsList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    case "artifacts":
      return (
        <SwitcherArtifactsList epicId={epicId} tabId={tabId} onClose={onClose} />
      );
    default:
      return <SwitcherCategoryPlaceholder categoryId={categoryId} />;
  }
}

function SwitcherCategoryPlaceholder(props: { readonly categoryId: LeftPanelId }) {
  return (
    <div
      data-testid={`mobile-switcher-panel-${props.categoryId}`}
      className="flex min-h-24 items-center justify-center p-6 text-ui-sm text-muted-foreground"
    >
      Coming soon
    </div>
  );
}
