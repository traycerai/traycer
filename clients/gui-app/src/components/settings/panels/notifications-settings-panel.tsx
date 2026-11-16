import { AccountNotificationHooksSection } from "./account-notification-hooks-section";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import type { HostNotificationSeverity } from "@traycer/protocol/host/notifications/host-notifications";
import { DEFAULT_ACCOUNT_NOTIFICATION_MATRIX } from "@traycer-clients/shared/environment/account-notification-schemas";
import { NEEDS_CONNECTION_MESSAGE } from "@traycer-clients/shared/environment/environment-cloud";
import { HOST_NOTIFICATIONS } from "./notifications-settings.definitions";
import { ACCOUNT_NOTIFICATIONS_COPY } from "./cloud-notification-copy";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Switch } from "@/components/ui/switch";
import {
  useAccountNotificationSettings,
  useAccountNotificationMatrixSave,
} from "@/hooks/notifications/use-account-notification-settings";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";

const SEVERITY_ROWS: ReadonlyArray<{
  readonly id: HostNotificationSeverity;
  readonly row: SettingsRowDefinition;
}> = [
  {
    id: "needs_action",
    row: HOST_NOTIFICATIONS.definitions.severityNeedsAction,
  },
  { id: "failure", row: HOST_NOTIFICATIONS.definitions.severityFailure },
  { id: "done", row: HOST_NOTIFICATIONS.definitions.severityDone },
  { id: "info", row: HOST_NOTIFICATIONS.definitions.severityInfo },
];

/** Account settings are read and saved on the sign-in, with no computer in the path. */
export function NotificationsSettingsPanel() {
  const viewerId = useCloudChatViewerId();
  const query = useAccountNotificationSettings();
  const save = useAccountNotificationMatrixSave();
  const account = query.data;
  const matrix =
    account?.settings?.matrix ?? DEFAULT_ACCOUNT_NOTIFICATION_MATRIX;
  return (
    <SettingsPanelShell
      title="Notifications"
      description={ACCOUNT_NOTIFICATIONS_COPY.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <SettingsGroup
        group={HOST_NOTIFICATIONS.definitions.inAppNotifications}
        showTitle
        tone="default"
        dataTestId="notifications-severity-policy"
        fill={false}
      >
        {query.isLoading ? (
          <div className="flex items-center gap-2 px-5 py-4 text-ui-sm text-muted-foreground">
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
            Loading notification settings
          </div>
        ) : null}
        {query.error === null ? null : (
          <p role="alert" className="px-5 py-4 text-ui-sm text-destructive">
            {query.error.message}
          </p>
        )}
        {account === undefined || query.error !== null
          ? null
          : SEVERITY_ROWS.map((severity) => (
              <SettingsRow
                key={severity.id}
                row={severity.row}
                control={
                  <Switch
                    checked={matrix[severity.id].renderer}
                    disabled={save.isPending || query.isFetching}
                    aria-label={`${severity.row.label} In-app notifications`}
                    data-testid={`notifications-severity-${severity.id}`}
                    onCheckedChange={(enabled) => {
                      save.mutate({
                        matrix: {
                          ...matrix,
                          [severity.id]: { renderer: enabled },
                        },
                        revision: account.revision,
                      });
                    }}
                  />
                }
              />
            ))}
        {!query.isLoading && account === undefined && query.error === null ? (
          <p className="px-5 py-4 text-ui-sm text-muted-foreground">
            {NEEDS_CONNECTION_MESSAGE.settings}
          </p>
        ) : null}
        {save.error === null ? null : (
          <p
            role="alert"
            className="border-t border-border/40 px-4 py-2.5 text-ui-xs text-destructive"
          >
            {save.error.message}
          </p>
        )}
      </SettingsGroup>
      {account === undefined || query.error !== null ? null : (
        <AccountNotificationHooksSection key={viewerId} account={account} />
      )}
      <p className="text-ui-sm text-muted-foreground">
        {ACCOUNT_NOTIFICATIONS_COPY.computerHooks}
      </p>
    </SettingsPanelShell>
  );
}

export { ComputerNotificationsSettingsPanel as NotificationsSettingsPanelForClient } from "./computer-notifications-settings-panel";
