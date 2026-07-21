import { Navigate } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useIsMobile } from "@/hooks/ui/use-mobile";

/**
 * On phones, `/settings` is the drill-down entry: a full-screen list of
 * sections (SettingsLayout renders no rail there). On wider screens the rail
 * already shows every section, so the index redirects to General as before.
 */
export function SettingsIndexRedirect() {
  const isMobile = useIsMobile();
  if (isMobile) {
    return <SettingsSidebar mode={{ kind: "route" }} variant="mobile-list" />;
  }
  return <Navigate to="/settings/general" replace />;
}
