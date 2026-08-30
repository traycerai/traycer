import type { ReactNode } from "react";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useNotificationSystemSettingsOpenMutation } from "@/hooks/runner/use-notification-system-settings-open-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";

/** Desktop pointer to native banner, badge and delivery preferences. */
export function SystemNotificationSettingsSection(): ReactNode {
  const systemSettings = useRunnerHost().notifications.systemSettings;
  const openSettings = useNotificationSystemSettingsOpenMutation();

  if (systemSettings === null) return null;

  return (
    <SettingsGroup
      title="System"
      tone="default"
      dataTestId="system-notification-settings-section"
      fill={false}
    >
      <SettingsRow
        label="OS notifications"
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
