import { type ReactNode } from "react";
import { ChevronRight, Menu } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { RateLimitIconButton } from "@/components/layout/header/rate-limit-icon";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { MobileNotificationsButton } from "@/components/notifications/mobile-notifications-button";
import { MobileEpicHeaderTitle } from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import { useRegisteredEpicTitle } from "@/lib/epic-selectors";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHeaderRightActions } from "@/stores/layout/mobile-header-right-actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";

/** Rendered only below md (see `AppHeader`), so desktop is untouched. */
export function MobileAppHeader(): ReactNode {
  const setNavOpen = useMobileNavStore((state) => state.setOpen);
  // See `useMobileHeaderRightActions` for why display is a resolution rather than something surfaces write here.
  const rightActions = useMobileHeaderRightActions();
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const surface = useMobileHeaderSurface();
  const epicTabId = surface.kind === "epic" ? surface.tabId : null;
  const epicId = useMobileHeaderEpicId(epicTabId);
  const title = useMobileHeaderTitle(surface, epicId, epicTabId);
  const settingsSection = settingsSectionLabel(surface);
  return (
    <header
      data-testid="app-header"
      data-variant="app"
      data-mobile-shell-touch-scope=""
      // `bg-background`, not the desktop header's `bg-canvas`: canvas exists to mark window chrome (title bar + tab
      // strip) apart from content, and at this width there is no tab strip.
      className="relative z-20 flex h-10 shrink-0 items-center gap-1 bg-background px-2 text-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-[''] pointer-coarse:touch-chrome"
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
      <MobileHeaderTitleSlot
        title={title}
        settingsSection={settingsSection}
        epicId={epicId}
      />
      {/* Right cluster: global status controls sit parallel to the hamburger, mirroring the desktop header's
         rate-limit + resource-monitor gating (navDisabled never applies here. */}
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
  /** The open epic on the presented epic tab; null on every other surface. */
  readonly epicId: string | null;
}

/** An epic's name is the one title the user owns, so it renders as an inline editable field rather than static
 * text; every other surface's title names a place in the app and is not the user's to change. */
function MobileHeaderTitleSlot(props: MobileHeaderTitleSlotProps): ReactNode {
  const { title, settingsSection, epicId } = props;
  if (settingsSection !== null) {
    return (
      // Unpadded crumbs so "Settings" sits exactly where the plain title does on the index route - no shift when the
      // section crumb appears.
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
  if (epicId !== null) {
    return (
      // Full-height slot so the title's tap target is the whole header row,
      // the same way the settings crumb takes its target from the row.
      <span
        className="flex h-full min-w-0 flex-1 items-center"
        data-testid="mobile-header-title"
      >
        <MobileEpicHeaderTitle epicId={epicId} title={title} />
      </span>
    );
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

/** `composer` covers the landing and draft surfaces plus an empty layout - everything the header does not
 * title. */
type MobileHeaderSurface =
  | { readonly kind: "epic"; readonly tabId: string }
  | { readonly kind: "history" }
  | { readonly kind: "settings"; readonly path: string | null }
  | { readonly kind: "composer" };

const COMPOSER_SURFACE: MobileHeaderSurface = { kind: "composer" };
const HISTORY_SURFACE: MobileHeaderSurface = { kind: "history" };

/** The two are one activation seen twice, and only the layout survives a cold start. */
function useMobileHeaderSurface(): MobileHeaderSurface {
  return useTabsStore(
    useShallow((state): MobileHeaderSurface => {
      const focused = selectHostFocusedRef(state);
      if (focused === null) return COMPOSER_SURFACE;
      switch (focused.kind) {
        case "epic":
          return { kind: "epic", tabId: focused.id };
        case "history":
          return HISTORY_SURFACE;
        case "settings":
          return {
            kind: "settings",
            path: state.systemTabs.settings?.lastPath ?? null,
          };
        case "draft":
          return COMPOSER_SURFACE;
      }
    }),
  );
}

/** The presented epic's id, resolved through its tab record. */
function useMobileHeaderEpicId(epicTabId: string | null): string | null {
  return useEpicCanvasStore((state) =>
    epicTabId === null ? null : (state.tabsById[epicTabId]?.epicId ?? null),
  );
}

/** The presented settings section's label when the settings tab is drilled into a section (depth 1), null on
 * its index and on every other surface. */
function settingsSectionLabel(surface: MobileHeaderSurface): string | null {
  if (surface.kind !== "settings" || surface.path === null) return null;
  const path = surface.path;
  const section = SETTINGS_SECTIONS.find((s) =>
    path.startsWith(`/settings/${s.id}`),
  );
  return section === undefined ? null : section.label;
}

/** The tab record's name is a persisted cache of that same title, so it is the faster of the two and carries
 * the header until the session projects. */
function useMobileHeaderTitle(
  surface: MobileHeaderSurface,
  epicId: string | null,
  epicTabId: string | null,
): string | null {
  const tabName = useEpicCanvasStore((state) =>
    epicTabId === null ? null : (state.tabsById[epicTabId]?.name ?? null),
  );
  const liveTitle = useRegisteredEpicTitle(epicId);
  // An epic whose name has not resolved yet falls through to no title rather than to a placeholder, so the
  // header never flashes a stand-in and then swaps it for the real name.
  if (surface.kind === "epic") return firstResolvedTitle(liveTitle, tabName);
  if (surface.kind === "settings") return "Settings";
  if (surface.kind === "history") return "History";
  // The composer surfaces - landing and drafts - are where you already are, and each one opens with a hero
  // greeting that carries the page, so "Traycer" and "New task" were both labelling the obvious.
  return null;
}

/** Blank is "not resolved yet", not a title: a tab record can hold an empty name, and rendering it would
 * present an empty rename field as though the epic were untitled. */
function firstResolvedTitle(
  preferred: string | null,
  fallback: string | null,
): string | null {
  const fromPreferred = preferred === null ? "" : preferred.trim();
  if (fromPreferred.length > 0) return fromPreferred;
  const fromFallback = fallback === null ? "" : fallback.trim();
  return fromFallback.length > 0 ? fromFallback : null;
}
