import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { NotificationHooksSection } from "./notification-hooks-section";
import { HostOverviewTabSections } from "./host-overview-tabs";
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
  const statusQuery = useNotificationHooksStatusForClient(props.client);
  const testHook = useNotificationHooksTestForClient(props.client);
  const saveHooks = useNotificationHooksSaveForClient(props.client);
  return (
    <HostOverviewTabSections>
      <NotificationHooksSection
        statusQuery={statusQuery}
        testHook={testHook}
        saveHooks={saveHooks}
      />
    </HostOverviewTabSections>
  );
}
