import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
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
import { useVoiceTopRowDrawn } from "@/components/layout/voice/use-voice-top-row-drawn";
import { VoiceTopRowControl } from "@/components/layout/voice/voice-top-row";
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
  const voiceDrawn = useVoiceTopRowDrawn();
  const centreZone = showTabStrip && voiceDrawn;
  const tabStripBoxRef = useRef<HTMLDivElement | null>(null);

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
      <div
        ref={tabStripBoxRef}
        className={tabStripBoxClass(showTabStrip, draggable, centreZone)}
      >
        {showTabStrip ? <TabStrip /> : null}
      </div>
      {centreZone ? (
        <HeaderCentreZone
          tabStripBoxRef={tabStripBoxRef}
          framelessDesktop={framelessDesktop}
          dragSuppressed={dragSuppressed}
        />
      ) : null}
      <div
        aria-hidden
        className={trailingSpacerClass(showTabStrip, centreZone)}
        style={spacerDragStyle}
      />
      {/* Shrinkable for the readings in it alone: the controls after them
          never give way. */}
      <div
        className="relative z-10 flex min-w-0 items-center gap-2"
        style={framelessDesktop ? NO_DRAG_STYLE : undefined}
      >
        {!navDisabled ? <AppUpdateHeaderButton layout="icon" /> : null}
        {!navDisabled ? <HeaderBarCluster /> : null}
        <div className="flex shrink-0 items-center gap-2">
          {!navDisabled ? <HistoryButton /> : null}
          {showBell ? <HeaderNotificationsBell /> : null}
          <HeaderIdentity
            showAppSettings={!navDisabled}
            hostsSignOutConfirm={navDisabled}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * The tab strip's box. The tabs keep a floor of the header, so readings moved
 * up here shrink before they do.
 */
function tabStripBoxClass(
  showTabStrip: boolean,
  draggable: boolean,
  centreZone: boolean,
): string {
  return cn(
    "relative z-10 flex items-center",
    // With a centre zone the box is as wide as its tabs, so they give up only
    // the width the zone needs, and it gives way before the zone's controls do.
    centreZone ? "flex-[0_1_auto]" : "flex-1",
    showTabStrip && !centreZone ? "min-w-[30%]" : "min-w-0",
    draggable && "[-webkit-app-region:drag]",
  );
}

/** The drag spacer before the right-side controls. */
function trailingSpacerClass(
  showTabStrip: boolean,
  centreZone: boolean,
): string {
  if (centreZone) return "relative z-10 hidden h-full min-w-0 flex-1 md:block";
  return cn(
    "relative z-10 h-full",
    showTabStrip
      ? "hidden shrink-0 basis-[clamp(2rem,6vw,6rem)] md:block"
      : "min-w-0 flex-1",
  );
}

/**
 * Talk, or the session strip, centred on the header. The gap before it is what
 * puts the zone's middle on the header's middle, and it closes as the tabs reach
 * the zone, so a long strip of tabs pushes the zone right rather than losing
 * width to it. The zone starts at its minimum (Talk, or the strip's controls)
 * and grows to the whole strip with the room left over, so the tabs keep their
 * width before the focus line and Waiting keep theirs. Measured because that gap depends on how wide the tabs
 * are, which CSS cannot subtract from half the header. Direct children of
 * `<header>`, for the drag-region reason given in `DesktopAppHeader`.
 */
function HeaderCentreZone(props: {
  readonly tabStripBoxRef: RefObject<HTMLDivElement | null>;
  readonly framelessDesktop: boolean;
  readonly dragSuppressed: boolean;
}): ReactNode {
  const { tabStripBoxRef } = props;
  const gapRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const gap = gapRef.current;
    const zone = zoneRef.current;
    const tabStripBox = tabStripBoxRef.current;
    const header = gap === null ? null : gap.parentElement;
    if (gap === null || zone === null || tabStripBox === null) return undefined;
    if (header === null) return undefined;
    const place = (): void => {
      const headerBox = header.getBoundingClientRect();
      const middle = headerBox.left + headerBox.width / 2;
      const zoneStart = middle - zone.getBoundingClientRect().width / 2;
      const tabsEnd = tabStripBox.getBoundingClientRect().right;
      gap.style.flexBasis = `${Math.max(0, Math.round(zoneStart - tabsEnd))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(header);
    observer.observe(zone);
    observer.observe(tabStripBox);
    return () => observer.disconnect();
  }, [tabStripBoxRef]);
  return (
    <>
      <div
        ref={gapRef}
        aria-hidden
        data-testid="app-header-centre-gap"
        className="relative z-10 h-full"
        style={titleBarSpacerStyle(
          props.framelessDesktop,
          props.dragSuppressed,
        )}
      />
      <div
        ref={zoneRef}
        data-testid="app-header-centre-zone"
        className="relative z-10 flex max-w-max min-w-min flex-1 items-center self-stretch px-2"
        style={props.framelessDesktop ? NO_DRAG_STYLE : undefined}
      >
        <VoiceTopRowControl />
      </div>
    </>
  );
}
