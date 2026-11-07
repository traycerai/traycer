import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { AGENT_MEMORIES } from "@/components/settings/panels/agent-memories.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys } from "@/lib/query-keys";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { configurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentAgentMemoriesQuery } from "@/hooks/environment/team/use-agent-memories-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { ConfigurationReadFailed } from "@/components/settings/environment/team-read-failed";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";

const AGENT_MEMORIES_GET = "config.agentMemories.get";
const AGENT_MEMORIES_SET = "config.agentMemories.set";

/**
 * Settings ▸ Agent memories: whether the configuration's agents are shown its
 * shared memories and keep them current.
 *
 * The memories belong to the configuration, not to a computer, so the switch
 * is read and written where the rest of the configuration is - from the
 * configuration itself on its own pages, and from the window's host otherwise
 * (`EnvironmentHostBinding` re-provides the binding `useHostClient()` names).
 * Personal and a team are separate configurations and so are separate
 * answers; nothing here can reach across them.
 */
export function AgentMemoriesSettingsPanel(): ReactNode {
  const source = useConfigurationSource();
  const personal = useConfigurationIsPersonal();
  const teamName =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const hostId = useAddressableHostId();
  // BOTH methods, because they negotiate independently: the row is an
  // interactive switch, so a host that could answer `get` but not `set` would
  // render a control whose every flip fails. Two statements, not one `&&`:
  // short-circuiting a hook call is a rules-of-hooks violation.
  const getSupported = useHostMethodSupport(hostId, AGENT_MEMORIES_GET);
  const setSupported = useHostMethodSupport(hostId, AGENT_MEMORIES_SET);
  const supported =
    getSupported === null || setSupported === null
      ? null
      : getSupported && setSupported;

  return (
    <SettingsPanelShell
      title="Agent memories"
      description={
        source.kind === "pool" && !personal
          ? `What ${teamName}'s agents carry from one task to the next, on every host running ${teamName}.`
          : "What your agents carry from one task to the next, on every computer and sandbox running this configuration."
      }
      bodyClassName="flex flex-col gap-3 overflow-visible rounded-none border-none bg-transparent"
    >
      {/* No group heading: the page has one row, and the group's title would
          only repeat the page's own. */}
      <SettingsGroup
        group={AGENT_MEMORIES.definitions.memories}
        showTitle={false}
        tone="default"
        dataTestId="settings-agent-memories"
        fill={false}
      >
        {source.kind === "pool" ? (
          <TeamAgentMemoriesRow />
        ) : (
          <HostAgentMemoriesRow supported={supported} />
        )}
      </SettingsGroup>
    </SettingsPanelShell>
  );
}

function HostAgentMemoriesRow(props: {
  readonly supported: boolean | null;
}): ReactNode {
  if (props.supported === true) return <AgentMemoriesRow />;
  return (
    <SettingsRow
      row={AGENT_MEMORIES.definitions.useTraycerMemories}
      status={
        props.supported === false
          ? "Update this host to change this setting."
          : undefined
      }
      control={
        <Switch
          checked={false}
          disabled
          aria-label="Use Traycer memories for agents"
        />
      }
    />
  );
}

const SETTING_STATUS = `${AGENT_MEMORIES.definitions.useTraycerMemories.description} Running agents pick this up on their next turn.`;

/**
 * The line under the host row: a read that failed, a write this host has not
 * caught up with (`settled: false` - it reached the configuration, and the
 * switch still shows what this host's agents do), or the setting itself.
 */
function hostRowStatus(input: {
  readonly readFailed: boolean;
  readonly settled: boolean | undefined;
}): string {
  if (input.readFailed)
    return "Couldn't read this host's agent memories setting. Check the host connection and reopen Settings.";
  if (input.settled === false)
    return "Saved to your configuration. This host hasn't picked it up yet; it will when it does.";
  return SETTING_STATUS;
}

/**
 * Rendered ONLY under a positive `useHostMethodSupport` for both the getter
 * and the setter, which is what makes `useHostClient()` safe here: a host that
 * advertised the methods has a binding.
 */
function AgentMemoriesRow(): ReactNode {
  const client = useHostClient();
  const query = useHostQuery<HostRpcRegistry, "config.agentMemories.get">({
    cacheKeyIdentity: undefined,
    client,
    method: AGENT_MEMORIES_GET,
    params: {},
    options: { enabled: true },
  });
  const setEnabled = useHostScopedMutationForClient(client, {
    method: AGENT_MEMORIES_SET,
    mutationKey: configMutationKeys.agentMemoriesSet(),
    errorMessage: "Couldn't update agent memories",
    invalidateMethods: [AGENT_MEMORIES_GET],
  });

  return (
    <SettingsRow
      row={AGENT_MEMORIES.definitions.useTraycerMemories}
      status={hostRowStatus({
        readFailed: query.isError,
        settled: setEnabled.data?.settled,
      })}
      control={
        <Switch
          checked={query.data?.enabled === true}
          disabled={query.isPending || query.isError || setEnabled.isPending}
          aria-label="Use Traycer memories for agents"
          onCheckedChange={(next) => {
            trackSettingChanged("agent-memories", "useTraycerMemories");
            setEnabled.mutate({ enabled: next });
          }}
        />
      }
    />
  );
}

/**
 * A configuration's own page. Editing follows the configuration's own
 * authority: a viewer reads the state as text, and everyone the
 * configuration lets write items may flip it.
 */
function TeamAgentMemoriesRow(): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const query = useEnvironmentAgentMemoriesQuery(false);
  const read = useBoundedRead(query);
  const { put } = useConfigurationItemMutations();
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  let control: ReactNode = null;
  if (read.pending)
    control = <span className="text-ui-xs text-muted-foreground">Loading</span>;
  else if (query.data !== undefined) {
    const data = query.data;
    control = canEdit ? (
      <Switch
        checked={data.enabled}
        disabled={put.isPending}
        aria-label="Use Traycer memories for agents"
        onCheckedChange={(enabled) => {
          if (source.kind !== "pool") return;
          put.mutate({
            environmentId: source.environmentId,
            kind: "agent_memory",
            key: "memory",
            os: null,
            value: { enabled },
            revision: data.revision,
          });
        }}
      />
    ) : (
      <span className="text-ui-sm text-muted-foreground">
        {data.enabled ? "On" : "Off"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SettingsRow
        row={AGENT_MEMORIES.definitions.useTraycerMemories}
        status={
          read.failed ? (
            <ConfigurationReadFailed
              page="agent memories"
              onRetry={read.retry}
            />
          ) : (
            SETTING_STATUS
          )
        }
        control={control}
      />
      <ConfigurationWriteFeedback issue={issue} />
    </div>
  );
}
