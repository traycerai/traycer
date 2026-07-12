import { useState, type ReactNode } from "react";
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
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useHostNotificationsConfig,
  useHostNotificationsConfigForClient,
} from "@/hooks/host/use-host-notifications-config-query";
import {
  useHostNotificationsSetConfig,
  useHostNotificationsSetConfigForClient,
} from "@/hooks/host/use-host-notifications-set-config-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { cn } from "@/lib/utils";

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
type SecretDraftMode = "leaveUnchanged" | "set" | "clear";
interface WebhookDraft {
  readonly url: string;
  readonly secret: string;
  readonly secretMode: SecretDraftMode;
}

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

const CHANNELS: ReadonlyArray<{
  readonly id: HostNotificationChannelId;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "renderer",
    label: "In-app",
    description: "Native OS toast and chime from the Traycer app.",
  },
  {
    id: "webhook",
    label: "Webhook",
    description: "POST to your endpoint from the host.",
  },
];

const EMPTY_RENDERER_CONFIG = {};
const LEAVE_SECRET_UNCHANGED: HostNotificationsSecretWrite = {
  kind: "leaveUnchanged",
};

export function NotificationsSettingsPanel() {
  return (
    <NotificationsSettingsPanelContent
      configQuery={useHostNotificationsConfig()}
      setConfig={useHostNotificationsSetConfig()}
    />
  );
}

export function NotificationsSettingsPanelForClient(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
}) {
  return (
    <NotificationsSettingsPanelContent
      configQuery={useHostNotificationsConfigForClient(props.client)}
      setConfig={useHostNotificationsSetConfigForClient(props.client)}
    />
  );
}

function NotificationsSettingsPanelContent(props: {
  readonly configQuery: UseQueryResult<NotificationConfig, HostRpcError>;
  readonly setConfig: NotificationSetConfigMutation;
}) {
  return (
    <SettingsPanelShell
      title="Notifications"
      description="Configure interruptions from Traycer. The bell feed always shows every notification, including collaboration updates; these controls only decide which events interrupt you."
    >
      {renderNotificationsSettingsContent(props.configQuery, props.setConfig)}
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
    <div className="divide-y divide-border/40">
      <NotificationMatrix
        config={data}
        configIsFetching={isFetching}
        setConfig={setConfig}
      />
      <WebhookSettingsForm config={data} setConfig={setConfig} />
    </div>
  );
}

function NotificationMatrix(props: {
  readonly config: NotificationConfig;
  readonly configIsFetching: boolean;
  readonly setConfig: NotificationSetConfigMutation;
}) {
  return (
    <section className="space-y-4 px-5 py-5">
      <SectionHeading
        title="Interruptions"
        description="Choose which severities can interrupt you in each channel. Informational collaboration activity stays feed-only."
        trailing={undefined}
      />
      <div className="overflow-x-auto">
        <div className="grid min-w-full grid-cols-[minmax(0,1.35fr)_repeat(2,minmax(0,1fr))] gap-px overflow-hidden rounded-md border border-border/60 bg-border/60">
          <div className="bg-muted/40 px-3 py-3 text-ui-xs font-medium uppercase text-muted-foreground">
            Severity
          </div>
          {CHANNELS.map((channel) => (
            <div key={channel.id} className="bg-muted/40 px-3 py-3 text-center">
              <div className="text-ui-sm font-medium text-foreground">
                {channel.label}
              </div>
              <p className="mt-1 text-ui-xs text-muted-foreground">
                {channel.description}
              </p>
            </div>
          ))}
          {SEVERITY_ROWS.flatMap((severity) => [
            <div key={`${severity.id}:label`} className="bg-card px-3 py-3">
              <div className="text-ui-sm font-medium text-foreground">
                {severity.label}
              </div>
              <p className="mt-1 text-ui-xs text-muted-foreground">
                {severity.description}
              </p>
            </div>,
            ...CHANNELS.map((channel) => (
              <div
                key={`${severity.id}:${channel.id}`}
                className="flex items-center justify-center bg-card px-3 py-3"
              >
                <Switch
                  checked={matrixValue(props.config, severity.id, channel.id)}
                  disabled={props.setConfig.isPending || props.configIsFetching}
                  aria-label={`${severity.label} ${channel.label} interruptions`}
                  data-testid={`notifications-matrix-${severity.id}-${channel.id}`}
                  onCheckedChange={(checked) => {
                    props.setConfig.mutate(
                      createMatrixToggleRequest(
                        props.config,
                        severity.id,
                        channel.id,
                        checked,
                      ),
                    );
                  }}
                />
              </div>
            )),
          ])}
        </div>
      </div>
      {props.setConfig.error === null ? null : (
        <p className="text-ui-xs text-destructive">
          {props.setConfig.error.message}
        </p>
      )}
    </section>
  );
}

function WebhookSettingsForm(props: {
  readonly config: NotificationConfig;
  readonly setConfig: NotificationSetConfigMutation;
}) {
  const webhook = props.config.channels.webhook;
  return (
    <WebhookSettingsFormDraft
      key={`${webhook.url ?? ""}:${webhook.credentialConfigured}`}
      config={props.config}
      setConfig={props.setConfig}
      initialDraft={{
        url: webhook.url ?? "",
        secret: "",
        secretMode: "leaveUnchanged",
      }}
    />
  );
}

function WebhookSettingsFormDraft(props: {
  readonly config: NotificationConfig;
  readonly setConfig: NotificationSetConfigMutation;
  readonly initialDraft: WebhookDraft;
}) {
  const webhook = props.config.channels.webhook;
  const [draft, setDraft] = useState(props.initialDraft);
  const secretWrite = secretWriteFromDraft(draft.secretMode, draft.secret);
  const saveDisabled =
    props.setConfig.isPending || !webhookUrlIsValid(draft.url);

  return (
    <form
      className="space-y-4 px-5 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (saveDisabled) return;
        props.setConfig.mutate(
          createWebhookRequest(props.config, draft.url, secretWrite),
          {
            onSuccess: () => {
              setDraft((previous) => ({
                ...previous,
                secret: "",
                secretMode: "leaveUnchanged",
              }));
            },
          },
        );
      }}
    >
      <SectionHeading
        title="Webhook"
        description="Send selected interruptions to an HTTPS endpoint. The signing secret is write-only and is never shown after saving."
        trailing={
          <CredentialStatus
            configured={webhook.credentialConfigured}
            lastError={webhook.lastError}
          />
        }
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Webhook URL" htmlFor="notifications-webhook-url">
          <Input
            id="notifications-webhook-url"
            value={draft.url}
            type="url"
            placeholder="https://example.com/traycer"
            aria-invalid={!webhookUrlIsValid(draft.url)}
            onChange={(event) => {
              const url = event.target.value;
              setDraft((previous) => ({ ...previous, url }));
            }}
          />
        </Field>
        <Field
          label="Webhook signing secret"
          htmlFor="notifications-webhook-secret"
        >
          <div className="flex min-w-0 gap-2">
            <Input
              id="notifications-webhook-secret"
              value={draft.secret}
              type="password"
              placeholder={
                webhook.credentialConfigured
                  ? "Leave blank to keep existing secret"
                  : "Optional signing secret"
              }
              onChange={(event) => {
                const next = event.target.value;
                setDraft((previous) => ({
                  ...previous,
                  secret: next,
                  secretMode: next.length === 0 ? "leaveUnchanged" : "set",
                }));
              }}
            />
            {webhook.credentialConfigured ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft((previous) => ({
                    ...previous,
                    secret: "",
                    secretMode: "clear",
                  }));
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <SecretDraftHint
            mode={draft.secretMode}
            configured={webhook.credentialConfigured}
          />
        </Field>
      </div>
      <FormActions>
        <Button type="submit" size="sm" disabled={saveDisabled}>
          {props.setConfig.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Save webhook
        </Button>
      </FormActions>
    </form>
  );
}

function SectionHeading(props: {
  readonly title: string;
  readonly description: string;
  readonly trailing: ReactNode | undefined;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h2 className="text-ui font-semibold text-foreground">{props.title}</h2>
        <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
          {props.description}
        </p>
      </div>
      {props.trailing === undefined ? null : (
        <div className="shrink-0">{props.trailing}</div>
      )}
    </div>
  );
}

function Field(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}

function FormActions(props: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {props.children}
    </div>
  );
}

function CredentialStatus(props: {
  readonly configured: boolean;
  readonly lastError: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Badge
        variant={props.configured ? "secondary" : "outline"}
        className={cn(
          props.configured ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {props.configured ? <CheckCircle2 data-icon="inline-start" /> : null}
        {props.configured ? "Credential configured" : "No credential"}
      </Badge>
      {props.lastError === null ? null : (
        <Badge variant="destructive">
          <AlertCircle data-icon="inline-start" />
          Last error
        </Badge>
      )}
      {props.lastError === null ? null : (
        <p className="basis-full text-right text-ui-xs text-destructive">
          {props.lastError}
        </p>
      )}
    </div>
  );
}

function SecretDraftHint(props: {
  readonly mode: SecretDraftMode;
  readonly configured: boolean;
}) {
  const text = secretDraftHintText(props.mode, props.configured);
  return <p className="text-ui-xs text-muted-foreground">{text}</p>;
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

function createMatrixToggleRequest(
  config: NotificationConfig,
  severity: HostNotificationSeverity,
  channelId: HostNotificationChannelId,
  enabled: boolean,
): NotificationSetConfigRequest {
  const matrix = completeMatrix(config);
  return {
    matrix: {
      ...matrix,
      [severity]: {
        ...matrix[severity],
        [channelId]: enabled,
      },
    },
    channels: configChannelsForSet(config),
  };
}

function createWebhookRequest(
  config: NotificationConfig,
  url: string,
  signingSecret: HostNotificationsSecretWrite,
): NotificationSetConfigRequest {
  return {
    matrix: completeMatrix(config),
    channels: {
      ...configChannelsForSet(config),
      webhook: {
        url: blankToNull(url),
        signingSecret,
      },
    },
  };
}

function configChannelsForSet(
  config: NotificationConfig,
): NotificationSetConfigRequest["channels"] {
  return {
    renderer: EMPTY_RENDERER_CONFIG,
    webhook: {
      url: config.channels.webhook.url,
      signingSecret: LEAVE_SECRET_UNCHANGED,
    },
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
    webhook: matrixValue(config, severity, "webhook"),
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

function secretWriteFromDraft(
  mode: SecretDraftMode,
  value: string,
): HostNotificationsSecretWrite {
  if (mode === "leaveUnchanged") return LEAVE_SECRET_UNCHANGED;
  if (mode === "clear") return { kind: "clear" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return LEAVE_SECRET_UNCHANGED;
  return { kind: "set", value: trimmed };
}

function secretDraftHintText(
  mode: SecretDraftMode,
  configured: boolean,
): string {
  if (mode === "set") return "A new secret will be saved.";
  if (mode === "clear") return "The saved secret will be cleared.";
  if (configured) return "Leave blank to keep the saved secret.";
  return "Leave blank to keep this channel without a secret.";
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function webhookUrlIsValid(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return trimmed.startsWith("https://");
}
