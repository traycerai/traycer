import { NotificationChimeSettingsSection } from "@/components/settings/panels/notification-chime-settings-section";
import { PushPermissionSection } from "@/components/settings/panels/push-permission-section";
import { SystemNotificationSettingsSection } from "@/components/settings/panels/system-notification-settings-section";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
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
      title="Sounds"
      description="Which chime plays for each kind of alert, across hosts."
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}>
        <NotificationChimeSettingsSection />
        <SystemNotificationSettingsSection />
        <PushPermissionSection />
        <SettingsGroup
          group={APP_NOTIFICATIONS.definitions.events}
          showTitle
          tone="default"
          dataTestId="notification-event-settings-section"
          fill={false}
        >
          <SettingsRow
            row={APP_NOTIFICATIONS.definitions.notificationEvents}
            status={undefined}
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
