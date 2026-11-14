import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { NotificationHooksSection } from "./notification-hooks-section";
import { NotificationLongTurnAlertRow } from "./notification-long-turn-alert-row";
import { HOST_NOTIFICATIONS } from "./notifications-settings.definitions";
import { HostOverviewTabSections } from "./host-overview-tabs";
import { SettingsGroup } from "@/components/settings/settings-group";
import {
  useHostLongTurnAlertForClient,
  useHostSetLongTurnAlertForClient,
} from "@/hooks/host/use-host-notifications-long-turn-alert";
import {
  useNotificationHooksSaveForClient,
  useNotificationHooksStatusForClient,
  useNotificationHooksTestForClient,
} from "@/hooks/host/use-notification-hooks-query";
import type { HostRpcRegistry } from "@/lib/host";

/** The picked computer's own settings; account hooks are edited on the account page. */
export function ComputerNotificationsSettingsPanel(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
}) {
  const query = useHostLongTurnAlertForClient(props.client);
  const setAlert = useHostSetLongTurnAlertForClient(props.client);
  const statusQuery = useNotificationHooksStatusForClient(props.client);
  const testHook = useNotificationHooksTestForClient(props.client);
  const saveHooks = useNotificationHooksSaveForClient(props.client);
  return (
    <HostOverviewTabSections>
      <SettingsGroup
        group={HOST_NOTIFICATIONS.definitions.inAppNotifications}
        showTitle={false}
        tone="default"
        dataTestId="computer-notifications-long-turn-alert"
        fill={false}
      >
        <NotificationLongTurnAlertRow query={query} setAlert={setAlert} />
      </SettingsGroup>
      <NotificationHooksSection
        statusQuery={statusQuery}
        testHook={testHook}
        saveHooks={saveHooks}
      />
    </HostOverviewTabSections>
  );
}
