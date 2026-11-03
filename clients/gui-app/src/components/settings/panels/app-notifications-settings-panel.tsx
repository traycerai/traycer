import { NotificationChimeSettingsSection } from "@/components/settings/panels/notification-chime-settings-section";
import { SoundtrackSettingsSection } from "@/components/settings/panels/soundtrack-settings-section";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";

export function AppNotificationsSettingsPanel() {
  return (
    <SettingsPanelShell
      title="Sounds"
      description="Which chime plays for each kind of alert."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className="space-y-6">
        <NotificationChimeSettingsSection />
        <SoundtrackSettingsSection />
      </div>
    </SettingsPanelShell>
  );
}
