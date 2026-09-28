import { useDesktopMenuBarActive } from "@/components/layout/header/use-desktop-menu-bar-active";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";

/**
 * Whether THIS window draws the mobile hamburger header in place of the
 * desktop chrome - the exact predicate `AppHeader` inlines, lifted so the
 * effective tab strip placement (`useTabStripPlacement`) and the header
 * cannot drift apart (S-11, S-12): a narrow desktop window that still has its
 * native menu row keeps the desktop chrome, mobile header and all.
 */
export function useMobileHeaderActive(): boolean {
  const isMobile = useIsMobileViewport();
  const desktopMenus = useDesktopMenuBarActive();
  return isMobile && !desktopMenus;
}
