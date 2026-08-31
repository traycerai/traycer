import { NotificationChimeSettingsSection } from "@/components/settings/panels/notification-chime-settings-section";
import { PushPermissionSection } from "@/components/settings/panels/push-permission-section";
import { SystemNotificationSettingsSection } from "@/components/settings/panels/system-notification-settings-section";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Button } from "@/components/ui/button";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

export function AppNotificationsSettingsPanel() {
  const compact = useSettingsDensity() === "compact";

  return (
    <SettingsPanelShell
      title="Notifications"
      description="How this app alerts you across hosts."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <NotificationChimeSettingsSection />
        <SystemNotificationSettingsSection />
        <PushPermissionSection />
        <SettingsGroup
          title="Events"
          tone="default"
          dataTestId="notification-event-settings-section"
          fill={false}
        >
          <SettingsRow
            label="Notification events"
            description="Choose which events alert you for the host selected in Settings."
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  navigateToSettingsSection("notifications");
                }}
              >
                Open Host Notifications
              </Button>
            }
          />
        </SettingsGroup>
      </div>
    </SettingsPanelShell>
  );
}
