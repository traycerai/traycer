import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useEffect, useState, type ReactNode } from "react";
import { Server, Trash2 } from "lucide-react";
import type { McpListData } from "@/hooks/providers/native-response-map";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useIsTextTruncated } from "@/hooks/ui/use-is-text-truncated";
import {
  useConfigurationMcpServerMutations,
  useConfigurationMcpServersQuery,
  type EnvironmentMcpServer,
} from "@/hooks/environment/team/use-mcp-servers";
import { useHostClient } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { cn } from "@/lib/utils";
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
import { McpIntroduction } from "./configuration-introduction";
import { McpServerDialog } from "./mcp-server-dialog";
import {
  initialMcpServerForm,
  mcpServerCredential,
  mcpServerPutRequest,
  mcpServerReady,
  type McpServerForm,
} from "./mcp-server-form";
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

function McpPage(props: { readonly children: ReactNode }): ReactNode {
  return (
    <SettingsPanelShell
      title="MCP servers"
      description={<McpIntroduction />}
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
      <McpPage>
        <MutedAgentSpinner />
      </McpPage>
    );
  if (version === false)
    return (
      <McpPage>
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
  const [adding, setAdding] = useState(false);
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  if (query.isPending)
    return (
      <McpPage>
        <MutedAgentSpinner />
      </McpPage>
    );
  if (query.isError)
    return (
      <McpPage>
        <TeamReadFailed
          message={mcpReadFailed(name)}
          onRetry={() => void query.refetch()}
        />
      </McpPage>
    );
  return (
    <McpPage>
      <section className="flex flex-col gap-3" aria-label="Servers">
        <ConfigurationWriteFeedback issue={issue} />
        <ConnectedServersHeading
          canEdit={canEdit}
          onAdd={() => setAdding(true)}
        />
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
                onIssue={setIssue}
              />
            ))}
          </ul>
        )}
        {adding ? (
          <McpServerDialog server={null} onClose={() => setAdding(false)} />
        ) : null}
      </section>
    </McpPage>
  );
}

function ConnectedServersHeading(props: {
  readonly canEdit: boolean;
  readonly onAdd: () => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <h2 className="text-ui-sm font-medium">Connected servers</h2>
      <span className="h-px min-w-4 flex-1 bg-border" />
      {props.canEdit ? (
        <Button type="button" size="sm" onClick={props.onAdd}>
          Add a server
        </Button>
      ) : null}
    </div>
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
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const { server } = props;
  const source = useConfigurationSource();
  const name = useConfigurationName();
  const { remove, setEnabled } = useConfigurationMcpServerMutations();
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
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const using = providersUsing(server, props.providers);
  const enabled = server.item !== null;
  const pending = setEnabled.isPending || remove.isPending;
  const status =
    open && detail !== null
      ? detail
      : collapsedServerStatus(server, using, props.providers.length);
  return (
    <li className="rounded-lg border border-border/60">
      <div className="flex items-center justify-between gap-3 p-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
          onClick={() => {
            setDetail(null);
            setOpen((current) => !current);
          }}
        >
          <ServerLetter name={server.name} />
          <span className="min-w-0">
            <span className="block truncate text-ui-sm font-medium">
              {server.name}
            </span>
            <ServerStatus enabled={enabled} line={status} />
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
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
          {props.canEdit && removable ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={pending}
              aria-label={`Remove ${server.name}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-4" />
            </Button>
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
      {open ? (
        <McpServerCardBody
          server={server}
          using={using}
          total={props.providers.length}
          canEdit={props.canEdit}
          onIssue={props.onIssue}
          onDetail={setDetail}
        />
      ) : null}
    </li>
  );
}

function ServerLetter(props: { readonly name: string }): ReactNode {
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-ui-sm font-semibold text-muted-foreground"
    >
      {props.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function ServerStatus(props: {
  readonly enabled: boolean;
  readonly line: string;
}): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          props.enabled ? "bg-success" : "bg-muted-foreground/30",
        )}
      />
      <span className="truncate">{props.line}</span>
    </span>
  );
}

function collapsedServerStatus(
  server: EnvironmentMcpServer,
  using: readonly ProviderId[],
  total: number,
): string {
  if (server.item === null)
    return [server.transport, DISABLED_SERVER_PHRASE].join(" · ");
  return [
    serverSwitchLabel(true),
    server.transport,
    providersPhrase(
      using.map((id) => providerDisplayName(id)),
      total,
    ),
  ].join(" · ");
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

interface McpToolListing {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
}

interface McpToolGroup {
  readonly name: string;
  readonly listed: readonly McpToolListing[];
}

type ToolDraft = Readonly<Record<string, boolean>>;

function McpServerCardBody(props: {
  readonly server: EnvironmentMcpServer;
  readonly using: readonly ProviderId[];
  readonly total: number;
  readonly canEdit: boolean;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
  readonly onDetail: (line: string | null) => void;
}): ReactNode {
  if (props.server.item === null) {
    return (
      <McpOpenEditor
        server={props.server}
        using={props.using}
        total={props.total}
        lists={[]}
        toolsKnown={false}
        canEdit={props.canEdit}
        onIssue={props.onIssue}
        onDetail={props.onDetail}
      />
    );
  }
  return (
    <TeamViewingHostBinding
      unavailable={
        <McpOpenEditor
          server={props.server}
          using={props.using}
          total={props.total}
          lists={[]}
          toolsKnown={false}
          canEdit={props.canEdit}
          onIssue={props.onIssue}
          onDetail={props.onDetail}
        />
      }
    >
      <McpToolReads providers={props.using} enabled lists={[]}>
        {(lists) => (
          <McpOpenEditor
            server={props.server}
            using={props.using}
            total={props.total}
            lists={lists}
            toolsKnown
            canEdit={props.canEdit}
            onIssue={props.onIssue}
            onDetail={props.onDetail}
          />
        )}
      </McpToolReads>
    </TeamViewingHostBinding>
  );
}

function McpOpenEditor(props: {
  readonly server: EnvironmentMcpServer;
  readonly using: readonly ProviderId[];
  readonly total: number;
  readonly lists: readonly ToolListQuery[];
  readonly toolsKnown: boolean;
  readonly canEdit: boolean;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
  readonly onDetail: (line: string | null) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const { put, putItem } = useConfigurationMcpServerMutations();
  const initial = endpointInitial(props.server);
  const [endpoint, setEndpoint] = useState(initial);
  const groups = groupServerTools(props.server, props.using, props.lists);
  const draft = useToolDraft(groups);
  const endpointDirty = endpoint !== initial;
  const toolsDirty = toolDraftDirty(groups, draft.value);
  const ready = endpointReady(props.server, endpoint);
  const pending = put.isPending || putItem.isPending;
  const canSave =
    !pending && (toolsDirty || endpointDirty) && (!endpointDirty || ready);
  const { onDetail, toolsKnown } = props;
  const enabledCount = enabledInDraft(groups, draft.value);
  const line =
    toolsKnown && groups.length > 0 ? enabledToolsLine(enabledCount) : null;
  useEffect(() => {
    onDetail(line);
  }, [onDetail, line]);
  const save = (): void => {
    if (source.kind !== "pool" || !canSave) return;
    const item = props.server.item;
    // mcpServers.put writes the item's toggles itself. Sending the stored
    // toggles beside a parallel items.put loses whichever lands last.
    if (endpointDirty) {
      const request = endpointPutRequest(
        props.server,
        endpoint,
        source.environmentId,
      );
      const saved =
        request === null || !toolsDirty || item === null
          ? request
          : {
              ...request,
              toolToggles: togglesFromDraft(
                item.toolToggles,
                groups,
                draft.value,
              ),
            };
      if (saved !== null)
        put.mutate(saved, {
          onSuccess: (result) =>
            props.onIssue(
              typedWriteIssue(result, "Couldn't save this server."),
            ),
        });
    }
    if (toolsDirty && item !== null && !endpointDirty)
      putItem.mutate(
        {
          environmentId: source.environmentId,
          kind: "mcp_server",
          key: item.key,
          os: null,
          value: mcpItemValue(
            props.server,
            togglesFromDraft(item.toolToggles, groups, draft.value),
            item.offFor,
          ),
          revision: item.revision,
        },
        {
          onSuccess: (result) => props.onIssue(configurationWriteIssue(result)),
        },
      );
  };
  return (
    <div className="flex flex-col gap-4 border-t border-border/60 px-3 py-4">
      <McpServerDetails
        server={props.server}
        endpoint={endpoint}
        using={props.using}
        total={props.total}
        toolCount={toolsKnown && groups.length > 0 ? groups.length : null}
        canEdit={props.canEdit}
        pending={pending}
        onEndpoint={setEndpoint}
      />
      <ToolReadNotices
        serverKey={props.server.item?.key ?? props.server.name}
        providers={props.using}
        lists={props.lists}
      />
      <McpToolGrid
        serverName={props.server.name}
        groups={groups}
        draft={draft.value}
        canEdit={props.canEdit}
        pending={pending}
        onToggle={draft.setTool}
        onEnableAll={() => draft.setAll(true)}
        onDisableAll={() => draft.setAll(false)}
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={!canSave} onClick={save}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

function McpServerDetails(props: {
  readonly server: EnvironmentMcpServer;
  readonly endpoint: string;
  readonly using: readonly ProviderId[];
  readonly total: number;
  readonly toolCount: number | null;
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onEndpoint: (value: string) => void;
}): ReactNode {
  const label = props.server.transport === "http" ? "Endpoint URL" : "Command";
  const fieldId = `mcp-endpoint-${props.server.serverId}`;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-foreground/5 p-4">
      <h3 className="text-ui-sm font-medium">Server details</h3>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId} variant="muted">
          {label}
        </Label>
        <Input
          id={fieldId}
          value={props.endpoint}
          disabled={!props.canEdit || props.pending}
          spellCheck={false}
          aria-label={`${label} for ${props.server.name}`}
          onChange={(event) => props.onEndpoint(event.target.value)}
          font="mono"
          size="xs"
        />
      </div>
      <p className="text-ui-xs text-muted-foreground">
        {serverDetailsMeta(
          props.server,
          props.using,
          props.total,
          props.toolCount,
        )}
      </p>
    </div>
  );
}

function serverDetailsMeta(
  server: EnvironmentMcpServer,
  using: readonly ProviderId[],
  total: number,
  toolCount: number | null,
): string {
  const names = using.map((id) => providerDisplayName(id));
  const phrase = providersPhrase(names, total);
  const parts: string[] = [server.transport];
  if (toolCount !== null) parts.push(toolCountPhrase(toolCount));
  parts.push(phrase);
  if (phrase === "all providers" && names.length > 0)
    parts.push(names.join(", "));
  return parts.join(" · ");
}

function endpointInitial(server: EnvironmentMcpServer): string {
  return server.transport === "http"
    ? (server.url ?? "")
    : (server.command ?? "");
}

function formForEndpoint(
  server: EnvironmentMcpServer,
  endpoint: string,
): McpServerForm {
  const form = initialMcpServerForm(server);
  if (server.transport === "http") return { ...form, url: endpoint };
  return { ...form, command: endpoint };
}

function endpointReady(
  server: EnvironmentMcpServer,
  endpoint: string,
): boolean {
  const form = formForEndpoint(server, endpoint);
  return mcpServerReady(form, mcpServerCredential(form, true, false));
}

function endpointPutRequest(
  server: EnvironmentMcpServer,
  endpoint: string,
  environmentId: string,
) {
  const form = formForEndpoint(server, endpoint);
  const credential = mcpServerCredential(form, true, false);
  if (credential === null || !mcpServerReady(form, credential)) return null;
  return mcpServerPutRequest(form, server, environmentId, credential);
}

function ToolReadNotices(props: {
  readonly serverKey: string;
  readonly providers: readonly ProviderId[];
  readonly lists: readonly ToolListQuery[];
}): ReactNode {
  return (
    <>
      {props.lists.some((list) => list.isPending) ? (
        <MutedAgentSpinner />
      ) : null}
      {props.lists.map((list, index) => {
        const providerId = props.providers.at(index);
        if (providerId === undefined) return null;
        return (
          <ToolReadNotice
            key={providerId}
            providerId={providerId}
            serverKey={props.serverKey}
            list={list}
          />
        );
      })}
    </>
  );
}

function ToolReadNotice(props: {
  readonly providerId: ProviderId;
  readonly serverKey: string;
  readonly list: ToolListQuery;
}): ReactNode {
  const label = providerDisplayName(props.providerId);
  if (props.list.isError && !props.list.isFetching)
    return (
      <TeamReadFailed
        message={`Couldn't read ${label}'s tools for this server.`}
        onRetry={() => void props.list.refetch()}
      />
    );
  if (
    props.list.data !== undefined &&
    !props.list.data.servers.some((server) => server.name === props.serverKey)
  )
    return (
      <p role="status" className="text-ui-xs text-muted-foreground">
        {`${label} hasn't listed this server's tools yet.`}
      </p>
    );
  return null;
}

function McpToolGrid(props: {
  readonly serverName: string;
  readonly groups: readonly McpToolGroup[];
  readonly draft: ToolDraft;
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onToggle: (name: string, next: boolean) => void;
  readonly onEnableAll: () => void;
  readonly onDisableAll: () => void;
}): ReactNode {
  if (props.groups.length === 0) return null;
  const enabled = enabledInDraft(props.groups, props.draft);
  const total = props.groups.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-sm font-medium">
          {"Available tools "}
          <span className="font-normal text-muted-foreground">
            {`(${enabled} of ${total})`}
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!props.canEdit || props.pending || enabled === total}
            onClick={props.onEnableAll}
          >
            Enable all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!props.canEdit || props.pending || enabled === 0}
            onClick={props.onDisableAll}
          >
            Disable all
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {props.groups.map((group) => (
          <div
            key={group.name}
            className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
          >
            <McpToolName name={group.name} />
            <Switch
              aria-label={`${props.serverName} ${group.name}`}
              checked={props.draft[group.name]}
              disabled={!props.canEdit || props.pending}
              onCheckedChange={(next) => props.onToggle(group.name, next)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function McpToolName(props: { readonly name: string }): ReactNode {
  const { ref, isTruncated } = useIsTextTruncated<HTMLSpanElement>(props.name);
  return (
    <div className="min-w-0 flex-1">
      <TooltipWrapper
        label={isTruncated ? props.name : null}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span ref={ref} className="block truncate text-ui-sm">
          {props.name}
        </span>
      </TooltipWrapper>
    </div>
  );
}

function groupServerTools(
  server: EnvironmentMcpServer,
  providers: readonly ProviderId[],
  lists: readonly ToolListQuery[],
): readonly McpToolGroup[] {
  const item = server.item;
  if (item === null) return [];
  const tools = new Map<string, McpToolListing[]>();
  lists.forEach((list, index) => {
    const providerId = providers.at(index);
    if (providerId === undefined) return;
    const harness = providerIdToGuiHarnessId(providerId);
    list.data?.servers
      .find((row) => row.name === item.key)
      ?.tools.forEach((tool) => {
        const listed = tools.get(tool.name) ?? [];
        listed.push({
          providerId,
          enabled: item.toolToggles[harness]?.[tool.name] ?? tool.enabled,
        });
        tools.set(tool.name, listed);
      });
  });
  return [...tools].map(([name, listed]) => ({ name, listed }));
}

function useToolDraft(groups: readonly McpToolGroup[]): {
  readonly value: ToolDraft;
  readonly setTool: (name: string, next: boolean) => void;
  readonly setAll: (next: boolean) => void;
} {
  const signature = groups
    .map(
      (group) =>
        `${group.name}:${group.listed.every((entry) => entry.enabled)}`,
    )
    .join("|");
  const [held, setHeld] = useState(signature);
  const [value, setValue] = useState<ToolDraft>(() => initialToolDraft(groups));
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());
  if (held !== signature) {
    setHeld(signature);
    setValue(adoptToolDraft(groups, value, edited));
  }
  return {
    value,
    setTool: (name, next) => {
      setEdited((current) => {
        const names = new Set(current);
        names.add(name);
        return names;
      });
      setValue((current) => ({ ...current, [name]: next }));
    },
    setAll: (next) => {
      setEdited(new Set(groups.map((group) => group.name)));
      setValue(draftAll(groups, next));
    },
  };
}

/**
 * A key the person has not changed is not an edit, including one filled in
 * while the tool list was still loading. Keep only names they set, and take
 * the rest from the lists that just arrived.
 */
function adoptToolDraft(
  groups: readonly McpToolGroup[],
  draft: ToolDraft,
  edited: ReadonlySet<string>,
): ToolDraft {
  const next: { [name: string]: boolean } = { ...initialToolDraft(groups) };
  for (const group of groups) {
    if (!edited.has(group.name)) continue;
    next[group.name] = draft[group.name];
  }
  return next;
}

function initialToolDraft(groups: readonly McpToolGroup[]): ToolDraft {
  const draft: { [name: string]: boolean } = {};
  for (const group of groups) {
    draft[group.name] = group.listed.every((entry) => entry.enabled);
  }
  return draft;
}

function draftAll(groups: readonly McpToolGroup[], next: boolean): ToolDraft {
  const draft: { [name: string]: boolean } = {};
  for (const group of groups) draft[group.name] = next;
  return draft;
}

function toolDraftDirty(
  groups: readonly McpToolGroup[],
  draft: ToolDraft,
): boolean {
  return groups.some(
    (group) =>
      draft[group.name] !== group.listed.every((entry) => entry.enabled),
  );
}

function enabledInDraft(
  groups: readonly McpToolGroup[],
  draft: ToolDraft,
): number {
  return groups.filter((group) => draft[group.name]).length;
}

function enabledToolsLine(count: number): string {
  return count === 1 ? "1 tool enabled" : `${count} tools enabled`;
}

function togglesFromDraft(
  stored: { [harness: string]: { [tool: string]: boolean } },
  groups: readonly McpToolGroup[],
  draft: ToolDraft,
): { [harness: string]: { [tool: string]: boolean } } {
  const toggles: { [harness: string]: { [tool: string]: boolean } } = {};
  for (const [harness, tools] of Object.entries(stored)) {
    toggles[harness] = { ...tools };
  }
  for (const group of groups) {
    const next = draft[group.name];
    const current = group.listed.every((entry) => entry.enabled);
    if (next === current) continue;
    for (const entry of group.listed) {
      const harness = providerIdToGuiHarnessId(entry.providerId);
      toggles[harness] = { ...toggles[harness], [group.name]: next };
    }
  }
  return toggles;
}
