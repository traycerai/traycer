import { useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import {
  useConfigurationMcpServerMutations,
  useConfigurationMcpServersQuery,
  type EnvironmentMcpServer,
} from "@/hooks/environment/team/use-mcp-servers";
import { useHostClient } from "@/lib/host";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { McpServerTools } from "./environment-mcp-servers";
import { mcpItemValue, useConfigurationName } from "./mcp-servers-model";
import { OnHostOnlyServers } from "./on-host-only-entries";
import {
  emptyServersTabLine,
  mcpReadFailed,
  serversCardHeading,
  toolCountPhrase,
} from "./mcp-skills-copy";
import { TeamMcpItems } from "./team-mcp-servers";
import { TeamReadFailed } from "./team-read-failed";
import { TeamViewingHostBinding } from "./team-viewing-host-binding";

/**
 * A provider's MCP tab on Personal or a team: which of the configuration's
 * servers this provider uses, with their tools, and what the provider added
 * on the viewing host by itself. Servers are added and edited on MCP servers.
 */
export function EnvironmentProviderMcpTab(props: {
  readonly providerId: ProviderId;
}): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    useHostClient(),
    "environment.configuration.mcpServers.list",
  );
  if (version === null) return <MutedAgentSpinner />;
  if (version === false)
    return (
      <TeamMcpItems providerId={providerIdToGuiHarnessId(props.providerId)} />
    );
  return <ProviderServers providerId={props.providerId} />;
}

function ProviderServers(props: {
  readonly providerId: ProviderId;
}): ReactNode {
  const query = useConfigurationMcpServersQuery();
  const name = useConfigurationName();
  const canEdit = useCanEditConfiguration();
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const label = providerDisplayName(props.providerId);
  const manage = (
    <Button
      type="button"
      variant="link"
      size="inline-xs"
      onClick={() => navigateToSettingsSection("mcp-servers")}
    >
      Manage servers
    </Button>
  );
  if (query.isPending) return <MutedAgentSpinner />;
  if (query.isError)
    return (
      <TeamReadFailed
        message={mcpReadFailed(name)}
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <ConfigurationWriteFeedback issue={issue} />
      <section
        className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
        aria-label={serversCardHeading(name, label)}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-ui-sm font-medium">
            {serversCardHeading(name, label)}
          </h3>
          {manage}
        </div>
        {query.data.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">
            {emptyServersTabLine(name)}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {query.data.map((server) => (
              <ProviderServerRow
                key={server.serverId}
                server={server}
                providerId={props.providerId}
                canEdit={canEdit}
                onIssue={setIssue}
              />
            ))}
          </ul>
        )}
      </section>
      <TeamViewingHostBinding unavailable={null}>
        <OnHostOnlyServers
          providerId={props.providerId}
          environmentNames={query.data.map(
            (server) => server.item?.key ?? server.name,
          )}
        />
      </TeamViewingHostBinding>
    </div>
  );
}

function ProviderServerRow(props: {
  readonly server: EnvironmentMcpServer;
  readonly providerId: ProviderId;
  readonly canEdit: boolean;
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const { server } = props;
  const source = useConfigurationSource();
  const { putItem } = useConfigurationMcpServerMutations();
  const [toolsOpen, setToolsOpen] = useState(false);
  const harness = providerIdToGuiHarnessId(props.providerId);
  const item = server.item;
  const uses = item !== null && !item.offFor.includes(harness);
  const label = providerDisplayName(props.providerId);
  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-ui-sm font-medium">{server.name}</div>
          <TeamViewingHostBinding
            unavailable={
              <div className="text-ui-xs text-muted-foreground">
                {server.transport}
              </div>
            }
          >
            <ProviderServerLine server={server} providerId={props.providerId} />
          </TeamViewingHostBinding>
        </div>
        <div className="flex items-center gap-2">
          {uses ? (
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
          <Switch
            aria-label={`${server.name} for ${label}`}
            checked={uses}
            disabled={!props.canEdit || item === null || putItem.isPending}
            onCheckedChange={(next) => {
              if (source.kind !== "pool" || item === null) return;
              const offFor = next
                ? item.offFor.filter((id) => id !== harness)
                : [...item.offFor.filter((id) => id !== harness), harness];
              putItem.mutate(
                {
                  environmentId: source.environmentId,
                  kind: "mcp_server",
                  key: item.key,
                  os: null,
                  value: mcpItemValue(server, item.toolToggles, offFor),
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
      </div>
      {toolsOpen && uses ? (
        <TeamViewingHostBinding unavailable={null}>
          <McpServerTools
            server={server}
            providerId={props.providerId}
            canEdit={props.canEdit}
            showProvider={false}
            onIssue={props.onIssue}
          />
        </TeamViewingHostBinding>
      ) : null}
    </li>
  );
}

function ProviderServerLine(props: {
  readonly server: EnvironmentMcpServer;
  readonly providerId: ProviderId;
}): ReactNode {
  const key = props.server.item?.key ?? props.server.name;
  const list = useProvidersMcpList({
    providerId: props.providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: props.server.item !== null,
    pollWhilePending: false,
  });
  const reported = list.data?.servers.find((row) => row.name === key);
  return (
    <div className="text-ui-xs text-muted-foreground">
      {reported === undefined
        ? props.server.transport
        : `${props.server.transport} · ${toolCountPhrase(reported.tools.length)}`}
    </div>
  );
}
