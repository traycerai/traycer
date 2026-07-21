import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useIsMobile } from "@/hooks/ui/use-mobile";
import { cn } from "@/lib/utils";
import "./settings-touch-targets.css";

export function SettingsLayout() {
  const isMobile = useIsMobile();
  return (
    <div
      data-settings-touch-scope
      className={cn(
        "flex min-h-0 flex-1 bg-background text-foreground",
        isMobile && "flex-col",
      )}
    >
      {isMobile ? (
        <MobileSectionHeader />
      ) : (
        <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * Mobile drill-down header: on a section route, a back link to the
 * full-screen section list at `/settings`. On the index (the list itself)
 * there is nothing to go back to, so nothing renders.
 */
function MobileSectionHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = SETTINGS_SECTIONS.find((s) =>
    pathname.startsWith(`/settings/${s.id}`),
  );
  if (section === undefined) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
      <Link
        to="/settings"
        className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-ui-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-accent-foreground"
      >
        <ChevronLeft className="size-4" />
        Settings
      </Link>
      <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
        {section.label}
      </span>
    </div>
  );
}
