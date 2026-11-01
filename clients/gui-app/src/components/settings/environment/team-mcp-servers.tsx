import { useState, type ReactNode } from "react";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { Switch } from "@/components/ui/switch";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useConfigurationMcpQuery } from "@/hooks/environment/team/use-mcp-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { configurationMcpValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useConfigurationSource,
  useCanEditConfiguration,
  useConfigurationIsPersonal,
} from "./configuration-source";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { ConfigurationReadFailed } from "./team-read-failed";
import { useConfigurationName } from "./team-pick-label";

export function TeamMcpServers(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const teamName = useConfigurationName();
  return (
    <SettingsPanelShell
      title="MCP servers"
      description={
        personal
          ? "Tools agents can call. Personal's servers reach every provider on every computer and sandbox running Personal."
          : `Tools agents can call. ${teamName}'s servers reach every provider on every host running ${teamName}.`
      }
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <TeamMcpItems providerId={null} />
    </SettingsPanelShell>
  );
}

export function TeamMcpItems(props: {
  readonly providerId: string | null;
}): ReactNode {
  const query = useConfigurationMcpQuery();
  const read = useBoundedRead(query);
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  if (query.isPending || query.isError)
    return read.failed ? (
      <ConfigurationReadFailed page="MCP servers" onRetry={read.retry} />
    ) : (
      <MutedAgentSpinner />
    );
  return (
    <div className="flex flex-col gap-3">
      <ConfigurationWriteFeedback issue={issue} />
      {query.data.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">No MCP servers.</p>
      ) : null}
      {query.data.map((item) => (
        <TeamMcpItem
          key={item.key}
          item={item}
          providerId={props.providerId}
          onOutcome={(result) => setIssue(configurationWriteIssue(result))}
        />
      ))}
    </div>
  );
}

function TeamMcpItem(props: {
  readonly item: ConfigurationItem;
  readonly providerId: string | null;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put } = useConfigurationItemMutations();
  const value = configurationMcpValueSchema.parse(props.item.value);
  const harnesses = Object.entries(value.toolToggles).filter(
    ([harness]) => props.providerId === null || harness === props.providerId,
  );
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <h3 className="text-ui-sm font-medium">{props.item.key}</h3>
      <p className="font-mono text-ui-xs text-muted-foreground">
        {value.mcpServerId}
      </p>
      {harnesses.map(([harness, tools]) => (
        <div key={harness} className="flex flex-col gap-2">
          <h4 className="text-ui-xs font-medium">{harness}</h4>
          {Object.entries(tools).map(([tool, enabled]) => (
            <div key={tool} className="flex items-center justify-between gap-3">
              <span className="text-ui-sm">{tool}</span>
              {canEdit ? (
                <Switch
                  aria-label={`${props.item.key} ${harness} ${tool}`}
                  checked={enabled}
                  disabled={put.isPending}
                  onCheckedChange={(next) => {
                    if (source.kind !== "pool") return;
                    put.mutate(
                      {
                        environmentId: source.environmentId,
                        kind: "mcp_server",
                        key: props.item.key,
                        os: null,
                        value: {
                          ...value,
                          toolToggles: {
                            ...value.toolToggles,
                            [harness]: { ...tools, [tool]: next },
                          },
                        },
                        revision: props.item.revision,
                      },
                      { onSuccess: props.onOutcome },
                    );
                  }}
                />
              ) : (
                <span className="text-ui-xs text-muted-foreground">
                  {enabled ? "On" : "Off"}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
