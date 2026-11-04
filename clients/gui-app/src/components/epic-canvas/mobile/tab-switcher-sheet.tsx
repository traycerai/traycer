import { useCallback } from "react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { TileSwitcherList } from "@/components/epic-canvas/mobile/tile-switcher-list";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  MobileTileOpenTargetContext,
  type MobileTileOpenTarget,
} from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

interface TabSwitcherSheetProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The slot a pick fills: the tile whose header opened the sheet. `null` from
   * the app header's trigger, where the shell's one tile takes the pick.
   */
  readonly target: MobileTileOpenTarget | null;
}

/**
 * The mobile tab switcher as a drag-dismissable `vaul` bottom sheet, the task's
 * list in every form. {@link TileSwitcherList} is its content.
 *
 * Opened from the mobile header's switcher trigger on a phone, and from a
 * tile's own header everywhere wider. Only meaningful on phones - it is
 * mounted from `MobileEpicTileView`, which itself renders only under the
 * `useIsMobileViewport()` canvas branch - and self-gates on
 * `useIsMobileViewport()` as defence.
 */
export function TabSwitcherSheet(props: TabSwitcherSheetProps) {
  const { epicId, tabId, open, onOpenChange, target } = props;
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
        // The installed iOS app overlays its keyboard on a window that keeps
        // its height and publishes the covered strip as `--keyboard-inset`
        // (0 everywhere else). The sheet stands on the keyboard rather than
        // under it, and gives up height above the 70dvh it would take where
        // the keyboard leaves less, so the list's search results stay in
        // reach. The cap is the safe height - below the status bar's strip as
        // well as above the keyboard - so the handle never rises into it.
        className={cn(
          resolvedTheme === "dark" && "dark",
          "bottom-(--keyboard-inset)! h-[min(70dvh,var(--spacing-safe-dvh))]",
        )}
      >
        {/* Inside the drawer content so it runs only while the sheet is open. */}
        {/* No `DrawerHeader`: vaul/Radix requires a title for screen readers,
            but the sheet's own content says what it is, so there is no visible
            heading for a header band to hold. */}
        <DrawerTitle className="sr-only">Switch tab</DrawerTitle>
        <MobileTileOpenTargetContext value={target}>
          <TileSwitcherList
            epicId={epicId}
            tabId={tabId}
            onClose={handleClose}
            trailing={null}
          />
        </MobileTileOpenTargetContext>
      </DrawerContent>
    </Drawer>
  );
}
