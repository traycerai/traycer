import type { ReactNode } from "react";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import { HistoryButton } from "@/components/layout/header/history-button";
import { HistoryNavButtons } from "@/components/layout/header/history-nav-buttons";
import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { DesktopMenuBar } from "@/components/layout/header/desktop-menu-bar";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import {
  HeaderBarCluster,
  HeaderIdentity,
  HeaderNotificationsBell,
} from "@/components/layout/header/header-actions";
import {
  isFramelessDesktop,
  NO_DRAG_STYLE,
  titleBarSpacerStyle,
  WINDOW_LEADING_INSET_CLASS,
  WINDOW_TRAILING_INSET_CLASS,
} from "@/components/layout/header/title-bar-drag";
import { cn } from "@/lib/utils";
import { useTitleBarDraggingSuppressed } from "@/stores/layout/title-bar-drag-store";

export type AppHeaderVariant = "app" | "host-loading";

export interface AppHeaderProps {
  readonly variant: AppHeaderVariant;
}

/**
 * App navigation chrome. Browser/mobile viewports below 768px use the
 * hamburger header. Installed Windows/Linux shells keep the desktop menu
 * and tab row at every zoom level.
 */
export function AppHeader(props: AppHeaderProps): ReactNode {
  // A zoomed desktop window still needs its menu row and native control insets;
  // the same predicate forces the effective tab strip placement to the top.
  const mobileHeaderActive = useMobileHeaderActive();
  if (props.variant === "app" && mobileHeaderActive) {
    return <MobileAppHeader />;
  }
  return <DesktopAppHeader variant={props.variant} />;
}

/**
 * Desktop navigation chrome. Frameless desktop shells use this row as the
 * native title bar: tabs and controls stay interactive, while the empty spacer
 * before the right-side controls remains available for window dragging.
 */
function DesktopAppHeader(props: AppHeaderProps): ReactNode {
  const { variant } = props;
  const showTabStrip = variant === "app";
  // Host-loading renders above the router and above the
  // notifications provider: nav links would crash, and the bell would
  // throw when its hooks can't find the stream context.
  const navDisabled = variant === "host-loading";
  const showBell = variant !== "host-loading";
  const framelessDesktop = isFramelessDesktop();
  // A header-anchored overlay (e.g. the resource monitor) needs the title bar to
  // stop swallowing clicks so a click there dismisses it. Drop drag while any
  // such overlay is open; restore it once they all close.
  const dragSuppressed = useTitleBarDraggingSuppressed();
  const draggable = framelessDesktop && !dragSuppressed;
  const spacerDragStyle = titleBarSpacerStyle(framelessDesktop, dragSuppressed);

  return (
    <header
      data-testid="app-header"
      data-variant={variant}
      className={cn(
        // The height is a shared token: the boot surfaces reserve this exact
        // slot so their card does not move when the header appears under it.
        APP_HEADER_HEIGHT_CLASS,
        "relative z-20 flex shrink-0 items-center bg-canvas text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-['']",
        { "md:bg-transparent md:after:hidden": showTabStrip },
        framelessDesktop
          ? cn(
              "pl-3 pr-3",
              WINDOW_LEADING_INSET_CLASS,
              WINDOW_TRAILING_INSET_CLASS,
            )
          : "px-3",
      )}
    >
      <DesktopMenuBar />
      {showTabStrip ? <HistoryNavButtons /> : null}
      {/* Left drag handle: breathing room beside the traffic lights +
          back/forward arrows so the window can be grabbed from the left end
          too. Desktop-only (the browser app has neither traffic lights nor
          arrows, so a left gap there would be stray).

          IMPORTANT: this must be a DIRECT child of <header> (a top-level
          title-bar element), mirroring the right-side spacer below. An
          otherwise-identical drag spacer nested inside the flex tab-strip
          section was NOT honored as a draggable region (only the right
          spacer, a direct header child, dragged). Electron registers
          `-webkit-app-region: drag` reliably only on top-level title-bar
          elements. */}
      {showTabStrip && framelessDesktop ? (
        <div
          aria-hidden
          className="relative z-10 hidden h-full shrink-0 basis-[clamp(2rem,6vw,6rem)] md:block"
          style={spacerDragStyle}
        />
      ) : null}
      <div className={tabStripBoxClass(showTabStrip, draggable)}>
        {showTabStrip ? <TabStrip /> : null}
      </div>
      <div
        aria-hidden
        className={cn(
          "relative z-10 h-full",
          showTabStrip
            ? "hidden shrink-0 basis-[clamp(2rem,6vw,6rem)] md:block"
            : "min-w-0 flex-1",
        )}
        style={spacerDragStyle}
      />
      {/* Shrinkable for the readings in it alone: the controls after them
          never give way (G6 review A). */}
      <div
        className="relative z-10 flex min-w-0 items-center gap-2"
        style={framelessDesktop ? NO_DRAG_STYLE : undefined}
      >
        {!navDisabled ? <AppUpdateHeaderButton layout="icon" /> : null}
        {!navDisabled ? <HeaderBarCluster /> : null}
        <div className="flex shrink-0 items-center gap-2">
          {!navDisabled ? <HistoryButton /> : null}
          {showBell ? <HeaderNotificationsBell /> : null}
          <HeaderIdentity showAppSettings={!navDisabled} />
        </div>
      </div>
    </header>
  );
}

/**
 * The tab strip's box. The tabs keep a floor of the header, so readings moved
 * up here shrink before they do (G6 review A).
 */
function tabStripBoxClass(showTabStrip: boolean, draggable: boolean): string {
  return cn(
    "relative z-10 flex flex-1 items-center",
    showTabStrip ? "min-w-[30%]" : "min-w-0",
    draggable && "[-webkit-app-region:drag]",
  );
}
