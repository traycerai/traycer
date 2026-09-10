import type { ReactNode } from "react";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useNotificationSystemSettingsOpenMutation } from "@/hooks/runner/use-notification-system-settings-open-mutation";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isSystemNotificationsGroupAvailable } from "@/lib/settings/settings-availability";

/** Desktop pointer to native banner, badge and delivery preferences. */
export function SystemNotificationSettingsSection(): ReactNode {
  const availability = useSettingsAvailabilityContext();
  const openSettings = useNotificationSystemSettingsOpenMutation();

  if (!isSystemNotificationsGroupAvailable(availability)) return null;

  return (
    <SettingsGroup
      title="System"
      anchor="app-notifications-system"
      tone="default"
      dataTestId="system-notification-settings-section"
      fill={false}
    >
      <SettingsRow
        label="OS notifications"
        anchor="app-notifications-os"
        description="Banners, badges, and delivery are managed by your operating system."
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
