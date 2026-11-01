import { useCallback } from "react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { TileSwitcherList } from "@/components/epic-canvas/mobile/tile-switcher-list";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface TabSwitcherSheetProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The mobile tab switcher as a drag-dismissable `vaul` bottom sheet, level 2's
 * form where nothing fits beside the content. {@link TileSwitcherList} is its
 * content.
 *
 * Opened from the mobile header's switcher trigger. Only meaningful on phones -
 * it is mounted from `MobileEpicTileView`, which itself renders only under the
 * `useIsMobileViewport()` canvas branch - and self-gates on `useIsMobileViewport()` as defence.
 */
export function TabSwitcherSheet(props: TabSwitcherSheetProps) {
  const { epicId, tabId, open, onOpenChange } = props;
  const isMobile = useIsMobileViewport();
  // The drawer content is portaled to <body>; re-assert the app's resolved
  // theme on it so `--popover` / `--background` (and the preset tokens) resolve
  // correctly inside the portal instead of falling back to the light :root.
  const { resolvedTheme, themePreset } = useResolvedTheme();
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  if (!isMobile) return null;

  return (
    <Drawer direction="bottom" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        data-mobile-shell-touch-scope=""
        data-testid="mobile-tab-switcher-sheet"
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark", "h-[70dvh]")}
      >
        {/* Inside the drawer content so it runs only while the sheet is open. */}
        {/* No `DrawerHeader`: vaul/Radix requires a title for screen readers,
            but the sheet's own content says what it is, so there is no visible
            heading for a header band to hold. */}
        <DrawerTitle className="sr-only">Switch tab</DrawerTitle>
        <TileSwitcherList epicId={epicId} tabId={tabId} onClose={handleClose} />
      </DrawerContent>
    </Drawer>
  );
}
