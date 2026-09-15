import type { ReactNode } from "react";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { DesktopMenuBar } from "@/components/layout/header/desktop-menu-bar";
import { useDesktopMenuBarActive } from "@/components/layout/header/use-desktop-menu-bar-active";
import { useTitleBarDraggingSuppressed } from "@/stores/layout/title-bar-drag-store";
import { cn } from "@/lib/utils";

/**
 * The same header slot before tabs can mount: startup, sign-in, and onboarding.
 * On shells without in-window menus it preserves the boot card's empty slot;
 * standalone routes only mount it when desktop menus are active.
 */
export function DesktopMenuHeader(): ReactNode {
  const active = useDesktopMenuBarActive();
  const dragSuppressed = useTitleBarDraggingSuppressed();
  if (!active) {
    return (
      <div aria-hidden className={cn("shrink-0", APP_HEADER_HEIGHT_CLASS)} />
    );
  }
  return (
    <div
      data-testid="desktop-menu-header"
      className={cn(
        APP_HEADER_HEIGHT_CLASS,
        "relative z-20 flex shrink-0 items-center bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']",
        "wco:pl-[env(titlebar-area-x,0px)] wco:pr-[max(12px,calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+12px))]",
        dragSuppressed
          ? "[-webkit-app-region:no-drag]"
          : "[-webkit-app-region:drag]",
      )}
    >
      <DesktopMenuBar />
    </div>
  );
}
