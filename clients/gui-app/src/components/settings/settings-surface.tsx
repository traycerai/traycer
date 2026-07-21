import { useRouterState } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";

/** Route-independent Settings body. The current route selects its section. */
export function SettingsSurface(props: { readonly lastPath: string | null }) {
  const sectionPath = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith("/settings")
        ? state.location.pathname
        : props.lastPath,
  });
  const section = settingsSectionFromPath(sectionPath);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-background text-foreground">
      <SettingsSidebar mode={{ kind: "route" }} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <SettingsPanelForSection section={section} />
      </div>
    </div>
  );
}

function settingsSectionFromPath(pathname: string | null) {
  if (pathname === "/settings/service") return "host";
  return (
    SETTINGS_SECTIONS.find(
      (candidate) => `/settings/${candidate.id}` === pathname,
    )?.id ?? "general"
  );
}
