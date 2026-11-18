import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SoundtrackSettingsSection } from "@/components/settings/panels/soundtrack-settings-section";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";

export function AppNotificationsSettingsPanel() {
  return (
    <SettingsPanelShell
      title={APP_NOTIFICATIONS.page.label}
      description={APP_NOTIFICATIONS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <SoundtrackSettingsSection />
    </SettingsPanelShell>
  );
}
