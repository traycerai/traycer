import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import {
  useConfigurationMcpServerMutations,
  useConfigurationMcpServersQuery,
  type EnvironmentMcpServer,
} from "@/hooks/environment/team/use-mcp-servers";
import { useHostClient } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "./configuration-source";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  typedWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { McpServerDialog } from "./mcp-server-dialog";
import {
  mcpItemValue,
  providersUsing,
  useConfigurationName,
  useMcpProviders,
} from "./mcp-servers-model";
import {
  DISABLED_SERVER_PHRASE,
  REMOVE_SERVER_LABEL,
  mcpPageSubtitle,
  mcpReadFailed,
  providersPhrase,
  removeReach,
  removeSecretLine,
  removeTitle,
  serverSwitchFailed,
  serverSwitchLabel,
  serverSwitchRefusal,
  toolCountPhrase,
} from "./mcp-skills-copy";
import { TeamMcpItems } from "./team-mcp-servers";
import { TeamReadFailed } from "./team-read-failed";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";

export function EnvironmentMcpServersPage(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  // Keyed by configuration: a draft or a write's outcome stays with the
  // configuration it was made in.
  const configurationKey = useConfigurationKey();
  return (
    <SettingsPanelShell
      title="MCP servers"
      description={mcpPageSubtitle(personal, name)}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <EnvironmentMcpServers key={configurationKey} />
    </SettingsPanelShell>
  );
}

function EnvironmentMcpServers(): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    useHostClient(),
    "environment.configuration.mcpServers.list",
  );
  if (version === null) return <MutedAgentSpinner />;
  // A host that predates the list shows the items it can read.
  if (version === false) return <TeamMcpItems providerId={null} />;
  return <McpServerList />;
}

function McpServerList(): ReactNode {
  const query = useConfigurationMcpServersQuery();
  const providers = useMcpProviders();
  const canEdit = useCanEditConfiguration();
  const name = useConfigurationName();
  const [editing, setEditing] = useState<EnvironmentMcpServer | "new" | null>(
    null,
  );
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  if (query.isPending) return <MutedAgentSpinner />;
  if (query.isError)
    return (
      <TeamReadFailed
        message={mcpReadFailed(name)}
        onRetry={() => void query.refetch()}
      />
    );
  const add = canEdit ? (
    <Button type="button" size="sm" onClick={() => setEditing("new")}>
      Add a server
    </Button>
  ) : null;
  return (
    <section className="flex flex-col gap-3" aria-label="Servers">
      <ConfigurationWriteFeedback issue={issue} />
      {query.data.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-ui-sm text-muted-foreground">
            MCP servers give agents tools.
          </p>
          {add}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-ui-sm font-medium">Servers</h3>
            {add}
          </div>
          <ul className="flex flex-col gap-2">
            {query.data.map((server) => (
              <McpServerRow
                key={server.serverId}
                server={server}
                providers={providers}
                canEdit={canEdit}
                onEdit={() => setEditing(server)}
                onIssue={setIssue}
              />
            ))}
          </ul>
        </>
      )}
      {editing === null ? null : (
        <McpServerDialog
          server={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function switchIssue(
  result: EnvironmentConfigurationWriteResponse,
  configuration: string,
  server: string,
  enabled: boolean,
): ConfigurationWriteIssue {
  if (result.outcome === "forbidden") return { kind: "forbidden" };
  if (result.outcome === "refused")
    return {
      kind: "refused",
      line: serverSwitchRefusal(result.reason, configuration, server, enabled),
    };
  return null;
}

function McpServerRow(props: {
  readonly server: EnvironmentMcpServer;
  readonly providers: readonly ProviderId[];
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const { server } = props;
  const source = useConfigurationSource();
  const name = useConfigurationName();
  const { remove, putItem, setEnabled } = useConfigurationMcpServerMutations();
  const client = useHostClient();
  const removable =
    useHostNegotiatedMethodVersion(
      client,
      "environment.configuration.mcpServers.delete",
    ) !== false;
  const switchable =
    useHostNegotiatedMethodVersion(
      client,
      "environment.configuration.mcpServers.setEnabled",
    ) !== false;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const using = providersUsing(server, props.providers);
  const enabled = server.item !== null;
  const pending = putItem.isPending || setEnabled.isPending || remove.isPending;
  const toolHost = using.at(0) ?? null;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-ui-sm font-medium">{server.name}</div>
          <TeamViewingHostBinding
            unavailable={
              <McpServerLine
                server={server}
                using={using}
                total={props.providers.length}
                toolCount={null}
              />
            }
          >
            <McpServerLineWithTools
              server={server}
              using={using}
              total={props.providers.length}
              toolHost={toolHost}
            />
          </TeamViewingHostBinding>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {enabled ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((open) => !open)}
            >
              Tools
            </Button>
          ) : null}
          {props.canEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onEdit}
            >
              Edit
            </Button>
          ) : null}
          {props.canEdit && removable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          ) : null}
          <span className="flex items-center gap-2 text-ui-xs text-muted-foreground">
            {serverSwitchLabel(enabled)}
            {props.canEdit && switchable ? (
              <Switch
                aria-label={server.name}
                checked={enabled}
                disabled={pending}
                onCheckedChange={(next) => {
                  if (source.kind !== "pool") return;
                  setEnabled.mutate(
                    {
                      environmentId: source.environmentId,
                      serverId: server.serverId,
                      enabled: next,
                    },
                    {
                      // A switch answers a configuration write, not an item
                      // write: it has no conflict to show.
                      onSuccess: (result) =>
                        props.onIssue(
                          switchIssue(result, name, server.name, next),
                        ),
                      onError: (error) =>
                        toastFromHostError(
                          error,
                          serverSwitchFailed(server.name, next),
                        ),
                    },
                  );
                }}
              />
            ) : null}
          </span>
        </div>
      </div>
      <RemoveServerDialog
        server={server}
        open={confirming}
        pending={remove.isPending}
        onOpenChange={setConfirming}
        onConfirm={() => {
          if (source.kind !== "pool") return;
          remove.mutate(
            { environmentId: source.environmentId, serverId: server.serverId },
            {
              // A refusal leaves the server and its credential in place.
              onSuccess: (result) =>
                props.onIssue(
                  typedWriteIssue(result, "Couldn't remove this server."),
                ),
              onSettled: () => setConfirming(false),
            },
          );
        }}
      />
      {toolsOpen && enabled ? (
        <TeamViewingHostBinding unavailable={null}>
          <div className="flex flex-col gap-3">
            {using.map((providerId) => (
              <McpServerTools
                key={providerId}
                server={server}
                providerId={providerId}
                canEdit={props.canEdit}
                showProvider
                onIssue={props.onIssue}
              />
            ))}
          </div>
        </TeamViewingHostBinding>
      ) : null}
    </li>
  );
}

/** Remove's confirm: where the server goes from, and what its secret does. */
function RemoveServerDialog(props: {
  readonly server: EnvironmentMcpServer;
  readonly open: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  const { credential } = props.server;
  return (
    <ConfirmDestructiveDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={removeTitle(props.server.name)}
      description={removeReach(personal, name, props.server.name)}
      cascadeSummary={null}
      actionLabel={REMOVE_SERVER_LABEL}
      isPending={props.pending}
      blockedReason={null}
      onConfirm={props.onConfirm}
    >
      {credential.kind === "secret" && credential.secretName !== null ? (
        <p className="px-5 pb-5 text-ui-sm text-muted-foreground">
          {removeSecretLine(credential.secretName, credential.owned)}
        </p>
      ) : null}
    </ConfirmDestructiveDialog>
  );
}

function McpServerLine(props: {
  readonly server: EnvironmentMcpServer;
  readonly using: readonly ProviderId[];
  readonly total: number;
  readonly toolCount: number | null;
}): ReactNode {
  const parts =
    props.server.item === null
      ? [props.server.transport, DISABLED_SERVER_PHRASE]
      : [
          props.server.transport,
          ...(props.toolCount === null
            ? []
            : [toolCountPhrase(props.toolCount)]),
          providersPhrase(
            props.using.map((id) => providerDisplayName(id)),
            props.total,
          ),
        ];
  return (
    <div className="text-ui-xs text-muted-foreground">{parts.join(" · ")}</div>
  );
}

/** The line with the tool count a host running the configuration reports. */
function McpServerLineWithTools(props: {
  readonly server: EnvironmentMcpServer;
  readonly using: readonly ProviderId[];
  readonly total: number;
  readonly toolHost: ProviderId | null;
}): ReactNode {
  const list = useProvidersMcpList({
    providerId: props.toolHost ?? "claude-code",
    scope: "global",
    workspaceRoot: null,
    enabled: props.toolHost !== null && props.server.item !== null,
    pollWhilePending: false,
  });
  const key = props.server.item?.key ?? props.server.name;
  const reported =
    props.toolHost === null
      ? undefined
      : list.data?.servers.find((row) => row.name === key);
  return (
    <McpServerLine
      server={props.server}
      using={props.using}
      total={props.total}
      toolCount={reported === undefined ? null : reported.tools.length}
    />
  );
}

/**
 * One provider's tools of a server, each with its switch, as the viewing host
 * reports them. A tool's switch writes the server's item.
 */
export function McpServerTools(props: {
  readonly server: EnvironmentMcpServer;
  readonly providerId: ProviderId;
  readonly canEdit: boolean;
  readonly showProvider: boolean;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const { putItem } = useConfigurationMcpServerMutations();
  const item = props.server.item;
  const list = useProvidersMcpList({
    providerId: props.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: item !== null,
    pollWhilePending: false,
  });
  if (item === null) return null;
  const harness = providerIdToGuiHarnessId(props.providerId);
  const tools =
    list.data?.servers.find((row) => row.name === item.key)?.tools ?? [];
  const label = providerDisplayName(props.providerId);
  return (
    <div className="flex flex-col gap-2">
      {props.showProvider ? (
        <h4 className="text-ui-xs font-medium">{label}</h4>
      ) : null}
      {list.isPending ? <MutedAgentSpinner /> : null}
      {tools.map((tool) => {
        const enabled = item.toolToggles[harness]?.[tool.name] ?? tool.enabled;
        return (
          <div
            key={tool.name}
            className="flex items-center justify-between gap-3"
          >
            <span className="min-w-0 truncate text-ui-sm">{tool.name}</span>
            <Switch
              aria-label={`${props.server.name} ${label} ${tool.name}`}
              checked={enabled}
              disabled={!props.canEdit || putItem.isPending}
              onCheckedChange={(next) => {
                if (source.kind !== "pool") return;
                putItem.mutate(
                  {
                    environmentId: source.environmentId,
                    kind: "mcp_server",
                    key: item.key,
                    os: null,
                    value: mcpItemValue(
                      props.server,
                      {
                        ...item.toolToggles,
                        [harness]: {
                          ...item.toolToggles[harness],
                          [tool.name]: next,
                        },
                      },
                      item.offFor,
                    ),
                    revision: item.revision,
                  },
                  {
                    onSuccess: (result) =>
                      props.onIssue(configurationWriteIssue(result)),
                  },
                );
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
