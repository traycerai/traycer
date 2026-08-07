import { type ReactNode } from "react";
import { ChevronRight, Menu } from "lucide-react";
import { Link, useMatch, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { MobileNotificationsButton } from "@/components/notifications/mobile-notifications-button";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { isHistoryPath } from "@/stores/tabs/kinds/history";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";

/**
 * The phone app header. Replaces the desktop tab strip + control cluster with a
 * hamburger (opens the navigation drawer), the current surface title, and a
 * right slot the active route fills with its own actions. Rendered only below
 * md (see `AppHeader`), so desktop is untouched.
 */
export function MobileAppHeader(): ReactNode {
  const setNavOpen = useMobileNavStore((state) => state.setOpen);
  const rightActions = useMobileHeaderStore((state) => state.rightActions);
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const title = useMobileHeaderTitle();
  const settingsSection = useSettingsSectionLabel();
  return (
    <header
      data-testid="app-header"
      data-variant="app"
      data-mobile-shell-touch-scope=""
      // `bg-background`, not the desktop header's `bg-canvas`: canvas exists to
      // mark window chrome (title bar + tab strip) apart from content, and at
      // this width there is no tab strip - the row is just a title sitting on
      // the page, so the 1.5% lightness step between the two tokens read as a
      // seam rather than as intent.
      className="relative z-20 flex h-[calc(2.5rem_+_env(safe-area-inset-top))] shrink-0 items-center gap-1 bg-background px-2 pt-[env(safe-area-inset-top)] text-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-['']"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Open menu"
        data-testid="mobile-nav-trigger"
        onClick={() => setNavOpen(true)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Menu className="size-4" />
      </Button>
      <MobileHeaderTitleSlot title={title} settingsSection={settingsSection} />
      {/* Right cluster: global status controls sit parallel to the hamburger,
          mirroring the desktop header's rate-limit + resource-monitor gating
          (navDisabled never applies here - MobileAppHeader only renders for the
          "app" variant). They come before the route-provided actions so a
          route's own controls (e.g. the epic overflow) land outermost. */}
      <div className="flex shrink-0 items-center gap-1">
        <RateLimitIconButton />
        {showGlobalResourceMonitor ? (
          <ResourceMonitorPopover className={undefined} />
        ) : null}
        {/* Last of the global controls, matching the desktop header's order
            (rate limit -> resource monitor -> bell). */}
        <MobileNotificationsButton />
        {rightActions}
      </div>
    </header>
  );
}

interface MobileHeaderTitleSlotProps {
  readonly title: string | null;
  readonly settingsSection: string | null;
}

/**
 * The header's centre slot. Always claims the row's spare width so the right
 * cluster stays pinned right, even on the landing route where there is no title
 * to show.
 */
function MobileHeaderTitleSlot(props: MobileHeaderTitleSlotProps): ReactNode {
  const { title, settingsSection } = props;
  if (settingsSection !== null) {
    return (
      // Drill-down breadcrumb for settings section routes: the parent crumb
      // navigates back to the full-screen section list, replacing the
      // dedicated back-link row the settings layout used to render.
      // Unpadded crumbs so "Settings" sits exactly where the plain title
      // does on the index route - no shift when the section crumb appears.
      // The link's tap target comes from the full header-row height.
      <span
        className="flex h-full min-w-0 flex-1 items-center gap-1"
        data-testid="mobile-header-title"
      >
        <Link
          to="/settings"
          data-testid="mobile-header-settings-crumb"
          className="flex h-full shrink-0 items-center font-medium text-muted-foreground transition-colors active:text-foreground"
        >
          Settings
        </Link>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">
          {settingsSection}
        </span>
      </span>
    );
  }
  if (title === null) {
    return <span className="min-w-0 flex-1" />;
  }
  return (
    <span
      className="min-w-0 flex-1 truncate font-medium text-foreground"
      data-testid="mobile-header-title"
    >
      {title}
    </span>
  );
}

/**
 * The active settings section's label when the route is a settings section
 * (drill-down depth 1), null on the settings index and everywhere else.
 */
function useSettingsSectionLabel(): string | null {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const section = SETTINGS_SECTIONS.find((s) =>
    pathname.startsWith(`/settings/${s.id}`),
  );
  return section === undefined ? null : section.label;
}

/**
 * Derives the header title from the active route: the open epic's name on the
 * epic route, otherwise a per-surface label.
 */
function useMobileHeaderTitle(): string | null {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const epicTabId = useMatch({
    from: "/epics/$epicId/$tabId",
    shouldThrow: false,
    select: (match) => match.params.tabId,
  });
  const epicName = useEpicCanvasStore((state) =>
    epicTabId === undefined ? null : (state.tabsById[epicTabId]?.name ?? null),
  );
  // An epic whose name has not resolved yet falls through to no title rather
  // than to a placeholder, so the header never flashes a stand-in and then
  // swaps it for the real name.
  if (epicTabId !== undefined && epicName !== null) return epicName;
  if (isSettingsPath(pathname)) return "Settings";
  if (isHistoryPath(pathname)) return "History";
  // Titles name a place you navigated TO. The composer surfaces - landing and
  // drafts - are where you already are, and each one opens with a hero greeting
  // that carries the page, so "Traycer" and "New task" were both labelling the
  // obvious. History, Settings and an epic's name are the ones that earn a row.
  return null;
}
