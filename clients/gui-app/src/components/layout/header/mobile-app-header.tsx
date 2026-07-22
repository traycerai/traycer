import { type ReactNode } from "react";
import { Menu } from "lucide-react";
import { useMatch, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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
  const title = useMobileHeaderTitle();
  return (
    <header
      data-testid="app-header"
      data-variant="app"
      className="relative z-20 flex h-10 shrink-0 items-center gap-1 bg-canvas px-2 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:z-1 after:h-px after:bg-border/90 after:content-['']"
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
      <span
        className="min-w-0 flex-1 truncate font-medium text-foreground"
        data-testid="mobile-header-title"
      >
        {title}
      </span>
      {/* Right slot: the active route (e.g. the epic view) contributes its own
          actions via the mobile-header store. Empty on surfaces that add none. */}
      <div className="flex shrink-0 items-center gap-1">{rightActions}</div>
    </header>
  );
}

/**
 * Derives the header title from the active route: the open epic's name on the
 * epic route, otherwise a per-surface label.
 */
function useMobileHeaderTitle(): string {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const epicTabId = useMatch({
    from: "/epics/$epicId/$tabId",
    shouldThrow: false,
    select: (match) => match.params.tabId,
  });
  const epicName = useEpicCanvasStore((state) =>
    epicTabId === undefined ? null : (state.tabsById[epicTabId]?.name ?? null),
  );
  if (epicTabId !== undefined) return epicName ?? "";
  if (isSettingsPath(pathname)) return "Settings";
  if (isHistoryPath(pathname)) return "History";
  if (pathname.startsWith("/draft")) return "New task";
  return "Traycer";
}
