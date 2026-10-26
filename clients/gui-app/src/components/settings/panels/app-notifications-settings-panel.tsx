import { NotificationChimeSettingsSection } from "@/components/settings/panels/notification-chime-settings-section";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";

export function AppNotificationsSettingsPanel() {
  return (
    <SettingsPanelShell
      title="Sounds"
      description="Which chime plays for each kind of alert, across hosts."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <NotificationChimeSettingsSection />
    </SettingsPanelShell>
  );
}
