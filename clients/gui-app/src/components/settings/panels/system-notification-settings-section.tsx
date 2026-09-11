import type { ReactNode } from "react";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useNotificationSystemSettingsOpenMutation } from "@/hooks/runner/use-notification-system-settings-open-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isSystemNotificationsGroupAvailable } from "@/lib/settings/settings-availability";

/**
 * Desktop pointer to native banner, badge and delivery preferences.
 *
 * The gate is the only thing rendered above it: every hook the group uses
 * reaches the runner host, which throws in a host-less shell, so they live in
 * the child and run only once the gate has passed.
 */
export function SystemNotificationSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (!isSystemNotificationsGroupAvailable(availability)) return null;
  return <SystemNotificationSettingsGroup />;
}

function SystemNotificationSettingsGroup(): ReactNode {
  const openSettings = useNotificationSystemSettingsOpenMutation();
  return (
    <SettingsGroup
      group={APP_NOTIFICATIONS.definitions.system}
      showTitle
      tone="default"
      dataTestId="system-notification-settings-section"
      fill={false}
    >
      <SettingsRow
        row={APP_NOTIFICATIONS.definitions.osNotifications}
        status={undefined}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={openSettings.isPending}
            data-testid="system-notification-settings-action"
            onClick={() => {
              openSettings.mutate();
            }}
          >
            {openSettings.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId="system-notification-settings-spinner"
                variant={undefined}
              />
            ) : null}
            Open Settings
          </Button>
        }
      />
    </SettingsGroup>
  );
}
