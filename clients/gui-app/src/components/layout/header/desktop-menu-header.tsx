import type { ReactNode } from "react";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { DesktopMenuBar } from "@/components/layout/header/desktop-menu-bar";
import {
  WINDOW_LEADING_INSET_CLASS,
  WINDOW_TRAILING_INSET_CLASS,
} from "@/components/layout/header/title-bar-drag";
import { useDesktopMenuBarActive } from "@/components/layout/header/use-desktop-menu-bar-active";
import { useTitleBarDraggingSuppressed } from "@/stores/layout/title-bar-drag-store";
import { cn } from "@/lib/utils";

/**
 * - `"boot"`: the header slot before tabs can mount (startup, sign-in,
 *   onboarding).
 * - `"title-band"`: the slim band at the top of an app window that has no
 *   header, as tall as the native window controls.
 */
export type DesktopMenuHeaderVariant = "boot" | "title-band";

export interface DesktopMenuHeaderProps {
  readonly variant: DesktopMenuHeaderVariant;
}

const BAR_SURFACE_CLASS =
  "relative z-20 flex shrink-0 items-center bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']";

/**
 * The window's top row when no app header is drawn, carrying the in-window
 * desktop menu bar where the shell has one.
 *
 * As `"boot"`, shells without in-window menus get an empty slot of the header's
 * height, so the boot card does not move when the header replaces it;
 * standalone routes only mount it when desktop menus are active. As
 * `"title-band"`, shells without in-window menus get an empty drag band that
 * exists only under a window-controls overlay, to sit beneath the macOS
 * traffic lights.
 */
export function DesktopMenuHeader(props: DesktopMenuHeaderProps): ReactNode {
  const { variant } = props;
  const active = useDesktopMenuBarActive();
  const dragSuppressed = useTitleBarDraggingSuppressed();
  const dragClass = dragSuppressed
    ? "[-webkit-app-region:no-drag]"
    : "[-webkit-app-region:drag]";

  if (variant === "title-band") {
    return (
      <div
        data-testid="app-title-band"
        aria-hidden={active ? undefined : true}
        className={cn(
          "h-[var(--app-title-band-height)] md:bg-transparent md:after:hidden",
          BAR_SURFACE_CLASS,
          active && WINDOW_LEADING_INSET_CLASS,
          active && WINDOW_TRAILING_INSET_CLASS,
          !active && "hidden wco:flex",
          dragClass,
        )}
      >
        {active ? <DesktopMenuBar /> : null}
      </div>
    );
  }

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
        BAR_SURFACE_CLASS,
        WINDOW_LEADING_INSET_CLASS,
        WINDOW_TRAILING_INSET_CLASS,
        dragClass,
      )}
    >
      <DesktopMenuBar />
    </div>
  );
}
