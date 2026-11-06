import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { McpListData } from "@/hooks/providers/native-response-map";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
import { OnHostOnlyServersLine } from "./on-host-only-entries";
import {
  mcpItemValue,
  providersUsing,
  useConfigurationName,
  useMcpProviders,
} from "./mcp-servers-model";
import {
  DISABLED_SERVER_PHRASE,
  REMOVE_SERVER_LABEL,
  MCP_PAGE_DESCRIPTION,
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
  const configurationKey = useConfigurationKey();
  return <EnvironmentMcpServers key={configurationKey} />;
}

function McpPage(props: {
  readonly children: ReactNode;
  readonly action: ReactNode;
}): ReactNode {
  return (
    <SettingsPanelShell
      title="MCP servers"
      description={MCP_PAGE_DESCRIPTION}
      headerAction={props.action}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {props.children}
    </SettingsPanelShell>
  );
}

function EnvironmentMcpServers(): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    useHostClient(),
    "environment.configuration.mcpServers.list",
  );
  if (version === null)
    return (
      <McpPage action={null}>
        <MutedAgentSpinner />
      </McpPage>
    );
  if (version === false)
    return (
      <McpPage action={null}>
        <TeamMcpItems providerId={null} />
      </McpPage>
    );
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
  if (query.isPending)
    return (
      <McpPage action={null}>
        <MutedAgentSpinner />
      </McpPage>
    );
  if (query.isError)
    return (
      <McpPage action={null}>
        <TeamReadFailed
          message={mcpReadFailed(name)}
          onRetry={() => void query.refetch()}
        />
      </McpPage>
    );
  return (
    <McpPage
      action={
        canEdit ? (
          <Button type="button" size="sm" onClick={() => setEditing("new")}>
            Add a server
          </Button>
        ) : null
      }
    >
      <section className="flex flex-col gap-3" aria-label="Servers">
        <ConfigurationWriteFeedback issue={issue} />
        {query.data.length === 0 ? (
          <>
            <p className="text-ui-sm text-muted-foreground">
              MCP servers give agents tools.
            </p>
            <TeamViewingHostBinding unavailable={null}>
              <OnHostOnlyServersLine
                providers={providers}
                environmentNames={[]}
              />
            </TeamViewingHostBinding>
          </>
        ) : (
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
        )}
        {editing === null ? null : (
          <McpServerDialog
            server={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
          />
        )}
      </section>
    </McpPage>
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
          <div className="wrap-anywhere text-ui-sm font-medium">
            {server.name}
          </div>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More for ${server.name}`}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={props.onEdit}>
                  Edit
                </DropdownMenuItem>
                {removable ? (
                  <DropdownMenuItem
                    disabled={pending}
                    onSelect={() => setConfirming(true)}
                  >
                    Remove
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
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
          <SharedMcpServerTools
            server={server}
            providers={using}
            canEdit={props.canEdit}
            onIssue={props.onIssue}
          />
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
  const reported = list.data?.servers.find((row) => row.name === item.key);
  const tools = reported?.tools ?? [];
  const label = providerDisplayName(props.providerId);
  return (
    <div className="flex flex-col gap-2">
      {props.showProvider ? (
        <h4 className="text-ui-xs font-medium">{label}</h4>
      ) : null}
      {list.isPending ? <MutedAgentSpinner /> : null}
      {/* The tools are the host's read, not the page's: say where it is. */}
      {list.isError && !list.isFetching ? (
        <TeamReadFailed
          message={`Couldn't read ${label}'s tools for this server.`}
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {list.data !== undefined && reported === undefined ? (
        <p role="status" className="text-ui-xs text-muted-foreground">
          {`${label} hasn't listed this server's tools yet.`}
        </p>
      ) : null}
      {tools.map((tool) => {
        const enabled = item.toolToggles[harness]?.[tool.name] ?? tool.enabled;
        return (
          <div
            key={tool.name}
            className="flex items-center justify-between gap-3"
          >
            <span className="min-w-0 wrap-anywhere text-ui-sm">
              {tool.name}
            </span>
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

type ToolListQuery = UseQueryResult<McpListData, HostRpcError>;

/** Each provider retains its own cached read and discovery polling. */
function McpToolReads(props: {
  readonly providers: readonly ProviderId[];
  readonly enabled: boolean;
  readonly lists: readonly ToolListQuery[];
  readonly children: (lists: readonly ToolListQuery[]) => ReactNode;
}): ReactNode {
  const providerId = props.providers.at(0);
  const list = useProvidersMcpList({
    providerId: providerId ?? "claude-code",
    scope: "global",
    workspaceRoot: null,
    enabled: props.enabled && providerId !== undefined,
    pollWhilePending: false,
  });
  if (providerId === undefined) return props.children(props.lists);
  return (
    <McpToolReads
      providers={props.providers.slice(1)}
      enabled={props.enabled}
      lists={[...props.lists, list]}
    >
      {props.children}
    </McpToolReads>
  );
}

/** One tool inventory, with provider-specific settings disclosed only when they differ. */
function SharedMcpServerTools(props: {
  readonly server: EnvironmentMcpServer;
  readonly providers: readonly ProviderId[];
  readonly canEdit: boolean;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  return (
    <McpToolReads
      providers={props.providers}
      enabled={props.server.item !== null}
      lists={[]}
    >
      {(lists) => <SharedMcpToolInventory {...props} lists={lists} />}
    </McpToolReads>
  );
}

function SharedMcpToolInventory(props: {
  readonly server: EnvironmentMcpServer;
  readonly providers: readonly ProviderId[];
  readonly canEdit: boolean;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
  readonly lists: readonly ToolListQuery[];
}): ReactNode {
  const source = useConfigurationSource();
  const { putItem } = useConfigurationMcpServerMutations();
  const item = props.server.item;
  const lists = props.lists;
  if (item === null) return null;
  const tools = new Map<
    string,
    { readonly providerId: ProviderId; readonly enabled: boolean }[]
  >();
  lists.forEach((list, index) => {
    const providerId = props.providers.at(index);
    if (providerId === undefined) return;
    const harness = providerIdToGuiHarnessId(providerId);
    list.data?.servers
      .find((server) => server.name === item.key)
      ?.tools.forEach((tool) => {
        const states = tools.get(tool.name) ?? [];
        states.push({
          providerId,
          enabled: item.toolToggles[harness]?.[tool.name] ?? tool.enabled,
        });
        tools.set(tool.name, states);
      });
  });
  const toggle = (
    name: string,
    providers: readonly ProviderId[],
    next: boolean,
  ): void => {
    if (source.kind !== "pool") return;
    const toggles = { ...item.toolToggles };
    providers.forEach((id) => {
      const harness = providerIdToGuiHarnessId(id);
      toggles[harness] = { ...toggles[harness], [name]: next };
    });
    putItem.mutate(
      {
        environmentId: source.environmentId,
        kind: "mcp_server",
        key: item.key,
        os: null,
        value: mcpItemValue(props.server, toggles, item.offFor),
        revision: item.revision,
      },
      { onSuccess: (result) => props.onIssue(configurationWriteIssue(result)) },
    );
  };
  const ready = lists.every((list) => list.isSuccess);
  return (
    <div className="flex flex-col gap-3">
      {lists.some((list) => list.isPending) ? <MutedAgentSpinner /> : null}
      {lists.map((list, index) => {
        const id = props.providers.at(index);
        if (id === undefined) return null;
        const label = providerDisplayName(id);
        if (list.isError && !list.isFetching)
          return (
            <TeamReadFailed
              key={id}
              message={`Couldn't read ${label}'s tools for this server.`}
              onRetry={() => void list.refetch()}
            />
          );
        if (
          list.data !== undefined &&
          !list.data.servers.some((server) => server.name === item.key)
        )
          return (
            <p
              key={id}
              role="status"
              className="text-ui-xs text-muted-foreground"
            >
              {label} hasn't listed this server's tools yet.
            </p>
          );
        return null;
      })}
      {[...tools].map(([name, states]) => {
        const enabled = states.every((state) => state.enabled);
        const mixed = !enabled && states.some((state) => state.enabled);
        const differs = mixed || states.length !== props.providers.length;
        return (
          <div key={name} className="flex flex-col gap-1">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 wrap-anywhere text-ui-sm">{name}</span>
              {mixed ? (
                <span className="ml-auto text-ui-xs text-muted-foreground">
                  Mixed
                </span>
              ) : null}
              <Switch
                aria-label={`${props.server.name} ${name}`}
                aria-checked={mixed ? "mixed" : enabled}
                checked={enabled}
                disabled={!props.canEdit || putItem.isPending || !ready}
                onCheckedChange={(next) =>
                  toggle(
                    name,
                    states.map((state) => state.providerId),
                    next,
                  )
                }
              />
            </div>
            {differs ? (
              <details className="text-ui-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  Differs by provider
                </summary>
                <div className="flex flex-col gap-2 pt-2">
                  {props.providers.map((id) => {
                    const state = states.find(
                      (entry) => entry.providerId === id,
                    );
                    return (
                      <div
                        key={id}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="min-w-0 wrap-anywhere">
                          {providerDisplayName(id)}
                          {state === undefined ? " · Not listed" : ""}
                        </span>
                        {state === undefined ? null : (
                          <Switch
                            aria-label={`${props.server.name} ${providerDisplayName(id)} ${name}`}
                            checked={state.enabled}
                            disabled={!props.canEdit || putItem.isPending}
                            onCheckedChange={(next) => toggle(name, [id], next)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
