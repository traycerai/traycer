import { Navigate } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";

/** Phones: /settings is the drill-down list. Wider: redirect to General; the rail already shows every section. */
export function SettingsIndexRedirect() {
  const isMobile = useIsMobileViewport();
  if (isMobile) {
    return <SettingsSidebar mode={{ kind: "route" }} variant="mobile-list" />;
  }
  return <Navigate to="/settings/general" replace />;
}
