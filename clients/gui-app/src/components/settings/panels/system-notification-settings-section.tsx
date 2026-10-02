import type { ReactNode } from "react";
import { APP_NOTIFICATIONS } from "@/components/settings/panels/app-notifications-settings.definitions";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useNotificationSystemSettingsOpenMutation } from "@/hooks/runner/use-notification-system-settings-open-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";

/**
 * Desktop pointer to native banner, badge and delivery preferences: one row of
 * the Sounds page's Notifications group, which the panel draws.
 *
 * The gate is the only thing rendered above it: every hook the row uses
 * reaches the runner host, which throws in a host-less shell, so they live in
 * the child and run only once the gate has passed.
 */
export function SystemNotificationSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  if (
    !APP_NOTIFICATIONS.definitions.osNotifications.availableWhen(availability)
  ) {
    return null;
  }
  return <SystemNotificationSettingsRow />;
}

function SystemNotificationSettingsRow(): ReactNode {
  const openSettings = useNotificationSystemSettingsOpenMutation();
  return (
    <SettingsRow
      row={APP_NOTIFICATIONS.definitions.osNotifications}
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
  );
}
