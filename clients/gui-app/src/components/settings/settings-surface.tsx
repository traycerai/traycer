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

/** Route-independent Settings body. The current route selects its section. */
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
  // Phone rules, unchanged in intent from when they lived on the route shell:
  // the rail is a pointer-width affordance, so below md the surface stacks and
  // drills down instead - the index lists the sections, a section shows its
  // panel alone, and the header's "Settings > <section>" crumb walks back up
  // (`mobile-app-header.tsx`) - all under the coarse-pointer hit-area scope.
  //
  // The index list has to be rendered HERE. It used to arrive through the
  // route outlet (`settings-index-route-components.tsx`), but the surface is
  // mounted by the settings TAB now and `SettingsLayout` renders nothing while
  // signed in, so nothing on that route ever mounts. Without this branch the
  // phone lands on General with no way to reach any other section.
  //
  // Desktop (>=768px) is unaffected: the rail already lists every section, and
  // the index falls through to General exactly as its `<Navigate>` did.
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

/** The section this path selects, or `null` at the `/settings` index. */
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
