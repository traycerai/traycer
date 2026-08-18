import { type CSSProperties, type ReactNode } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import { HistoryButton } from "@/components/layout/header/history-button";
import { HistoryNavButtons } from "@/components/layout/header/history-nav-buttons";
import { ProjectProfileSwitcher } from "@/components/layout/header/project-profile-switcher";
import { WindowsMenuBar } from "@/components/layout/header/windows-menu-bar";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { APP_HEADER_HEIGHT_CLASS } from "@/components/layout/header/app-header-height";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTitleBarDraggingSuppressed } from "@/stores/layout/title-bar-drag-store";

// Frameless-desktop detection: Electron's preload bridge exposes
// `window.runnerHost` via `contextBridge.exposeInMainWorld`. Browser
// shells never see it. Reliable in Electron 42 with sandbox + app://
// scheme + Chromium UA reduction (UA sniffing is not).
function isFramelessDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    Object.prototype.hasOwnProperty.call(window, "runnerHost")
  );
}

// `-webkit-app-region` isn't in the standard CSSProperties typings.
const DRAG_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

// Drag style for the header's title-bar spacers: only frameless desktop shells
// use them as an OS drag region, and only while no header overlay needs the
// title bar to receive clicks (see `useTitleBarDraggingSuppressed`).
function titleBarSpacerStyle(
  framelessDesktop: boolean,
  dragSuppressed: boolean,
): CSSProperties | undefined {
  if (!framelessDesktop) return undefined;
  return dragSuppressed ? NO_DRAG_STYLE : DRAG_STYLE;
}

export type AppHeaderVariant = "app" | "host-loading";

export interface AppHeaderProps {
  readonly variant: AppHeaderVariant;
}

/**
 * App navigation chrome. Frameless desktop shells use this row as the native
 * title bar: tabs and controls stay interactive, while the empty spacer after
 * the tab strip remains available for window dragging.
 */
export function AppHeader(props: AppHeaderProps): ReactNode {
  const { variant } = props;
  const showTabStrip = variant === "app";
  // Host-loading renders above the router and above the
  // notifications provider: nav links would crash, and the bell would
  // throw when its hooks can't find the stream context.
  const navDisabled = variant === "host-loading";
  const showBell = variant !== "host-loading";
  const framelessDesktop = isFramelessDesktop();
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
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
        framelessDesktop
          ? cn(
              "pl-3 pr-3",
              "wco:pl-[env(titlebar-area-x,82px)]",
              "wco:pr-[max(12px,calc(100vw-env(titlebar-area-x,82px)-env(titlebar-area-width,100vw)+12px))]",
            )
          : "px-3",
      )}
    >
      <WindowsMenuBar />
      {showTabStrip ? <HistoryNavButtons /> : null}
      <HeaderProjectProfileSlot
        enabled={!navDisabled}
        framelessDesktop={framelessDesktop}
      />
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-center",
          showTabStrip && "pl-1",
          draggable && "[-webkit-app-region:drag]",
        )}
      >
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
      <div
        className="relative z-10 flex shrink-0 items-center gap-2"
        style={framelessDesktop ? NO_DRAG_STYLE : undefined}
      >
        {!navDisabled ? <AppUpdateHeaderButton /> : null}
        {!navDisabled ? <RateLimitIconButton /> : null}
        {!navDisabled && showGlobalResourceMonitor ? (
          <ResourceMonitorPopover className={undefined} />
        ) : null}
        {!navDisabled ? <HistoryButton /> : null}
        {showBell ? <HeaderNotificationsBell /> : null}
        <HeaderIdentity showAppSettings={!navDisabled} />
      </div>
    </header>
  );
}

function HeaderProjectProfileSlot(props: {
  readonly enabled: boolean;
  readonly framelessDesktop: boolean;
}) {
  if (!props.enabled) return null;
  return (
    <div
      className="relative z-10 shrink-0"
      style={props.framelessDesktop ? NO_DRAG_STYLE : undefined}
    >
      <ProjectProfileSwitcher />
    </div>
  );
}

// Hiding the bell when signed-out keeps the notifications-store +
// runner-host subscriptions from mounting for a signed-out session.
export function HeaderNotificationsBell() {
  const isSignedIn = useAuthStore((state) => state.status === "signed-in");
  if (!isSignedIn) {
    return null;
  }
  return <NotificationsBell />;
}

interface HeaderIdentityProps {
  readonly showAppSettings: boolean;
}

function HeaderIdentity(props: HeaderIdentityProps) {
  const profile = useAuthStore((state) => state.profile);
  const isSignedIn = useAuthStore((state) => state.status === "signed-in");
  if (isSignedIn && profile !== null) {
    return (
      <UserMenu
        userName={profile.userName}
        email={profile.email}
        avatarUrl={profile.avatarUrl ?? null}
        showAppSettings={props.showAppSettings}
      />
    );
  }
  return <SignInButton layout="compact" />;
}
