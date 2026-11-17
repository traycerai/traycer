import { AccountNotificationHooksSection } from "./account-notification-hooks-section";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { NEEDS_CONNECTION_MESSAGE } from "@traycer-clients/shared/environment/environment-cloud";
import { ACCOUNT_NOTIFICATIONS_COPY } from "./cloud-notification-copy";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useAccountNotificationSettings } from "@/hooks/notifications/use-account-notification-settings";

/** Account settings are read and saved on the sign-in, with no computer in the path. */
export function NotificationsSettingsPanel() {
  const viewerId = useCloudChatViewerId();
  const query = useAccountNotificationSettings();
  const account = query.data;
  return (
    <SettingsPanelShell
      title="Notifications"
      description={ACCOUNT_NOTIFICATIONS_COPY.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {query.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-ui-sm text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
          Loading notification settings
        </div>
      ) : null}
      {query.error === null ? null : (
        <p role="alert" className="py-4 text-ui-sm text-destructive">
          {query.error.message}
        </p>
      )}
      {!query.isLoading && account === undefined && query.error === null ? (
        <p className="py-4 text-ui-sm text-muted-foreground">
          {NEEDS_CONNECTION_MESSAGE.settings}
        </p>
      ) : null}
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
