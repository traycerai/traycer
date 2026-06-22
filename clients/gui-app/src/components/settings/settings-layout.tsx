import { Outlet } from "@tanstack/react-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";

export function SettingsLayout() {
  return (
    <div className="flex min-h-0 flex-1 bg-background text-foreground">
      <SettingsSidebar mode={{ kind: "route" }} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
