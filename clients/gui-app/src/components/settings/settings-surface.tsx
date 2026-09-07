import { useRouterState } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { cn } from "@/lib/utils";
import "./settings-touch-targets.css";

export function SettingsSurface(props: { readonly lastPath: string | null }) {
  const sectionPath = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith("/settings")
        ? state.location.pathname
        : props.lastPath,
  });
  // `null` at `/settings` itself - the index, which is depth 0 of the phone
  // drill-down and NOT a section.
  const section = settingsSectionFromPath(sectionPath);
  // Without this branch the phone lands on General with no way to reach any other section.
  const isMobile = useIsMobileViewport();

  return (
    <div
      data-settings-touch-scope
      className={cn(
        "flex min-h-0 min-w-0 flex-1 bg-background text-foreground",
        isMobile && "flex-col",
      )}
    >
      {isMobile ? null : (
        <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {isMobile && section === null ? (
          <SettingsSidebar mode={{ kind: "route" }} variant="mobile-list" />
        ) : (
          <SettingsPanelForSection section={section ?? "general"} />
        )}
      </div>
    </div>
  );
}

function settingsSectionFromPath(
  pathname: string | null,
): SettingsSectionId | null {
  if (pathname === "/settings/service") return "host";
  return (
    SETTINGS_SECTIONS.find(
      (candidate) => `/settings/${candidate.id}` === pathname,
    )?.id ?? null
  );
}
