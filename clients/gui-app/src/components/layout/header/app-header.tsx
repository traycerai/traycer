import { type CSSProperties, type ReactNode } from "react";
import { UserMenu } from "@/components/auth/user-menu";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import { HistoryButton } from "@/components/layout/header/history-button";
import { HistoryNavButtons } from "@/components/layout/header/history-nav-buttons";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth/auth-store";

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

export type AppHeaderVariant = "app" | "host-loading";

export interface AppHeaderProps {
  readonly variant: AppHeaderVariant;
}

/**
 * App navigation chrome. Frameless desktop shells use this row as the native
 * title bar: tabs and controls stay interactive, while the empty spacer before
 * the right-side controls remains available for window dragging.
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

  return (
    <header
      data-testid="app-header"
      data-variant={variant}
      className={cn(
        "relative z-20 flex h-10 shrink-0 items-center bg-canvas text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-['']",
        framelessDesktop
          ? cn(
              "pl-3 pr-3",
              "wco:pl-[env(titlebar-area-x,82px)]",
              "wco:pr-[max(12px,calc(100vw-env(titlebar-area-x,82px)-env(titlebar-area-width,100vw)+12px))]",
            )
          : "px-3",
      )}
    >
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
          style={DRAG_STYLE}
        />
      ) : null}
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-center",
          framelessDesktop && "[-webkit-app-region:drag]",
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
        style={framelessDesktop ? DRAG_STYLE : undefined}
      />
      <div
        className="relative z-10 flex shrink-0 items-center gap-2"
        style={framelessDesktop ? NO_DRAG_STYLE : undefined}
      >
        {!navDisabled ? <AppUpdateHeaderButton /> : null}
        {!navDisabled ? <HistoryButton /> : null}
        {showBell ? <HeaderNotificationsBell /> : null}
        <HeaderIdentity showAppSettings={!navDisabled} />
      </div>
    </header>
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
