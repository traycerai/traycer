import {
  useHostLongTurnAlertForClient,
  useHostSetLongTurnAlertForClient,
  type LongTurnAlertQuery,
  type SetLongTurnAlertMutation,
} from "@/hooks/host/use-host-notifications-long-turn-alert";
import {
  useNotificationHooksSaveForClient,
  useNotificationHooksStatusForClient,
  useNotificationHooksTestForClient,
  type NotificationHooksSaveMutation,
  type NotificationHooksStatusQuery,
  type NotificationHooksTestMutation,
} from "@/hooks/host/use-notification-hooks-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { NotificationHooksSection } from "@/components/settings/panels/notification-hooks-section";
import { NotificationLongTurnAlertCard } from "@/components/settings/panels/notification-long-turn-alert-row";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  useAccountHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * The route / modal entry point.
 *
 * The long-turn alert and the hooks are stored BY THE HOST, so this panel was
 * always host-scoped — it just never said which host, and silently configured
 * whichever one happened to be active under a heading that read "Current
 * host". It was the worst of the invisible bindings: a person could edit
 * hooks all evening and never learn that the bell they were watching
 * belonged to a different host. It now reads the one Settings host scope, and
 * the sidebar that owns that scope names the host and says so explicitly when
 * it is not the one this window's bell reads from.
 */
export function NotificationsSettingsPanel() {
  const scope = useAccountHostScope();
  return (
    <NotificationsSettingsPanelContent
      scope={scope}
      longTurnAlertQuery={useHostLongTurnAlertForClient(scope.client)}
      setLongTurnAlert={useHostSetLongTurnAlertForClient(scope.client)}
      hooksStatusQuery={useNotificationHooksStatusForClient(scope.client)}
      testHook={useNotificationHooksTestForClient(scope.client)}
      saveHooks={useNotificationHooksSaveForClient(scope.client)}
    />
  );
}

export function NotificationsSettingsPanelForClient(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
}) {
  return (
    <NotificationsSettingsPanelContent
      scope={null}
      longTurnAlertQuery={useHostLongTurnAlertForClient(props.client)}
      setLongTurnAlert={useHostSetLongTurnAlertForClient(props.client)}
      hooksStatusQuery={useNotificationHooksStatusForClient(props.client)}
      testHook={useNotificationHooksTestForClient(props.client)}
      saveHooks={useNotificationHooksSaveForClient(props.client)}
    />
  );
}

function NotificationsSettingsPanelContent(props: {
  /** `null` when the caller supplied a client directly and owns the gating. */
  readonly scope: HostScope | null;
  readonly longTurnAlertQuery: LongTurnAlertQuery;
  readonly setLongTurnAlert: SetLongTurnAlertMutation;
  readonly hooksStatusQuery: NotificationHooksStatusQuery;
  readonly testHook: NotificationHooksTestMutation;
  readonly saveHooks: NotificationHooksSaveMutation;
}) {
  const compact = useSettingsDensity() === "compact";
  const { scope } = props;
  const body = (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        compact ? "gap-3.5" : "gap-5",
      )}
    >
      <NotificationLongTurnAlertCard
        query={props.longTurnAlertQuery}
        setAlert={props.setLongTurnAlert}
      />
      <div className="min-h-0 flex-1">
        {/* Keyed by host. The editor below holds an open hook draft and an
            armed pending-delete, and a save rebuilds the host's ENTIRE hooks
            file from the list it is looking at. Those two pieces of state
            belong to one machine, but nothing here unmounts when the scope
            moves: switching to a host whose hooks are already cached kept the
            draft and the armed delete on screen while every mutation prop
            re-pointed at the new client, so confirming wrote the new host's
            file using an intent armed against the old one — copying a hook
            across machines, or deleting whichever hook happened to share the
            id. Changing hosts has to DESTROY that state, not re-point it.
            Same guarantee, and the same reasoning, as the key on
            `HostRegistryUpdates`. */}
        <NotificationHooksSection
          key={scope?.hostId}
          statusQuery={props.hooksStatusQuery}
          testHook={props.testHook}
          saveHooks={props.saveHooks}
        />
      </div>
    </div>
  );

  return (
    <SettingsPanelShell
      title="Notifications"
      description="Long-turn alerts from this host, and what its automation receives. Choose which kinds interrupt you under Application → Alerts."
      fillHeight
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
      // The header named the scoped host until the sidebar started doing it a
      // row away and permanently. Two statements of one fact is how the old
      // surface got confusing; this is the one place it was still true.
      headerAction={undefined}
    >
      {scope === null ? (
        body
      ) : (
        <HostScopeGate
          scope={scope}
          skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
        >
          {body}
        </HostScopeGate>
      )}
    </SettingsPanelShell>
  );
}
