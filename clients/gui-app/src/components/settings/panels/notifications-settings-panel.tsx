import type { ReactNode } from "react";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type {
  HostNotificationChannelId,
  HostNotificationSeverity,
  HostNotificationsSecretWrite,
} from "@traycer/protocol/host/notifications/host-notifications";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Switch } from "@/components/ui/switch";
import { useHostNotificationsConfigForClient } from "@/hooks/host/use-host-notifications-config-query";
import { useHostNotificationsSetConfigForClient } from "@/hooks/host/use-host-notifications-set-config-mutation";
import {
  useNotificationHooksSaveForClient,
  useNotificationHooksStatusForClient,
  useNotificationHooksTestForClient,
  type NotificationHooksSaveMutation,
  type NotificationHooksStatusQuery,
  type NotificationHooksTestMutation,
} from "@/hooks/host/use-notification-hooks-query";
import { NotificationHooksSection } from "@/components/settings/panels/notification-hooks-section";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

type NotificationConfig = ResponseOfMethod<
  HostRpcRegistry,
  "host.notifications.getConfig"
>;
type NotificationSetConfigRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notifications.setConfig"
>;
type NotificationSetConfigMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.notifications.setConfig">,
  HostRpcError,
  NotificationSetConfigRequest,
  { readonly hostId: string | null }
>;
const SEVERITY_ROWS: ReadonlyArray<{
  readonly id: HostNotificationSeverity;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "needs_action",
    label: "Needs action",
    description: "Approvals and interviews.",
  },
  {
    id: "failure",
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
  },
  {
    id: "done",
    label: "Done",
    description: "Completed or intentionally stopped turns.",
  },
];

const EMPTY_RENDERER_CONFIG = {};
const LEAVE_SECRET_UNCHANGED: HostNotificationsSecretWrite = {
  kind: "leaveUnchanged",
};

/**
 * The route / modal entry point.
 *
 * Notification policy and hooks are stored BY THE HOST, so this panel was
 * always host-scoped — it just never said which host, and silently configured
 * whichever one happened to be active under a heading that read "Current
 * host". It was the worst of the invisible bindings: a person could toggle
 * severities all evening and never learn that the bell they were watching
 * belonged to a different host. It now reads the one Settings host scope, and
 * the sidebar that owns that scope names the host and says so explicitly when
 * it is not the one this window's bell reads from.
 */
export function NotificationsSettingsPanel() {
  const scope = useHostScope();
  return (
    <NotificationsSettingsPanelContent
      scope={scope}
      configQuery={useHostNotificationsConfigForClient(scope.client)}
      setConfig={useHostNotificationsSetConfigForClient(scope.client)}
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
      configQuery={useHostNotificationsConfigForClient(props.client)}
      setConfig={useHostNotificationsSetConfigForClient(props.client)}
      hooksStatusQuery={useNotificationHooksStatusForClient(props.client)}
      testHook={useNotificationHooksTestForClient(props.client)}
      saveHooks={useNotificationHooksSaveForClient(props.client)}
    />
  );
}

function NotificationsSettingsPanelContent(props: {
  /** `null` when the caller supplied a client directly and owns the gating. */
  readonly scope: HostScope | null;
  readonly configQuery: UseQueryResult<NotificationConfig, HostRpcError>;
  readonly setConfig: NotificationSetConfigMutation;
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
      <SettingsGroup
        // Was "In-app notifications · Current host" — a title whose only
        // qualifier was the one fact the screen refused to resolve. The sidebar
        // names the host now, so the title is free to name the setting.
        title="In-app notifications"
        tone="default"
        dataTestId="notifications-severity-policy"
        fill={false}
      >
        {renderNotificationsSettingsContent(props.configQuery, props.setConfig)}
      </SettingsGroup>
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
      description="What this host surfaces, and what its automation receives."
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

function renderNotificationsSettingsContent(
  configQuery: UseQueryResult<NotificationConfig, HostRpcError>,
  setConfig: NotificationSetConfigMutation,
): ReactNode {
  const { data, error, isFetching, isLoading } = configQuery;
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading notification settings
      </div>
    );
  }
  if (error !== null) {
    return (
      <InlineState
        tone="error"
        title="Couldn't load notification settings"
        detail={error.message}
      />
    );
  }
  if (data === undefined) {
    return (
      <InlineState
        tone="neutral"
        title="Notification settings unavailable"
        detail="Connect to a host to configure delivery."
      />
    );
  }
  return (
    <NotificationSeverityList
      config={data}
      configIsFetching={isFetching}
      setConfig={setConfig}
    />
  );
}

function NotificationSeverityList(props: {
  readonly config: NotificationConfig;
  readonly configIsFetching: boolean;
  readonly setConfig: NotificationSetConfigMutation;
}) {
  return (
    <>
      {SEVERITY_ROWS.map((severity) => (
        <SettingsRow
          key={severity.id}
          label={severity.label}
          description={severity.description}
          control={
            <Switch
              checked={matrixValue(props.config, severity.id, "renderer")}
              disabled={props.setConfig.isPending || props.configIsFetching}
              aria-label={`${severity.label} In-app notifications`}
              data-testid={`notifications-severity-${severity.id}`}
              onCheckedChange={(checked) => {
                props.setConfig.mutate(
                  createSeverityToggleRequest(
                    props.config,
                    severity.id,
                    checked,
                  ),
                );
              }}
            />
          }
        />
      ))}
      {props.setConfig.error === null ? null : (
        <p className="border-t border-border/40 px-4 py-2.5 text-ui-xs text-destructive">
          {props.setConfig.error.message}
        </p>
      )}
    </>
  );
}

function InlineState(props: {
  readonly tone: "neutral" | "error";
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="space-y-1 px-5 py-4">
      <div
        className={cn(
          "text-ui-sm font-medium",
          props.tone === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {props.title}
      </div>
      <p className="text-ui-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

function createSeverityToggleRequest(
  config: NotificationConfig,
  severity: HostNotificationSeverity,
  enabled: boolean,
): NotificationSetConfigRequest {
  const matrix = completeMatrix(config);
  return {
    matrix: {
      ...matrix,
      [severity]: {
        ...matrix[severity],
        renderer: enabled,
      },
    },
    channels: configChannelsForSet(config),
  };
}

function configChannelsForSet(
  config: NotificationConfig,
): NotificationSetConfigRequest["channels"] {
  return {
    renderer: EMPTY_RENDERER_CONFIG,
    email: {
      host: config.channels.email.host,
      port: config.channels.email.port,
      user: config.channels.email.user,
      from: config.channels.email.from,
      password: LEAVE_SECRET_UNCHANGED,
    },
  };
}

function completeMatrix(
  config: NotificationConfig,
): NotificationConfig["matrix"] {
  return {
    info: channelRow(config, "info"),
    needs_action: channelRow(config, "needs_action"),
    failure: channelRow(config, "failure"),
    done: channelRow(config, "done"),
  };
}

function channelRow(
  config: NotificationConfig,
  severity: HostNotificationSeverity,
) {
  return {
    renderer: matrixValue(config, severity, "renderer"),
    email: matrixValue(config, severity, "email"),
  };
}

function matrixValue(
  config: NotificationConfig,
  severity: HostNotificationSeverity,
  channelId: HostNotificationChannelId,
): boolean {
  return config.matrix[severity][channelId];
}
