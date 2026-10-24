import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { BROWSER_AGENT_ACCESS } from "@/components/settings/panels/browser-agent-access.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys } from "@/lib/query-keys";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import { configurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import {
  useCanAdministerConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentBrowserAccessQuery } from "@/hooks/environment/team/use-browser-access-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";

const AGENT_BROWSER_ACCESS_GET = "config.browser.get";
const AGENT_BROWSER_ACCESS_SET = "config.browser.set";

/**
 * Settings > Personal > Browser agent access: whether agents get the in-app
 * browser as a tool. Its own page rather than a row on Browser,
 * because Browser is this app's own browsing and stays with the window, while
 * this follows the person.
 *
 * Read through the window's own host, like every Personal page: that is the
 * host `useAddressableHostId()` and `useHostClient()` already name outside a
 * host-scoped binding, so no picker reaches it.
 */
export function BrowserAgentAccessSettingsPanel(): ReactNode {
  const source = useConfigurationSource();
  const hostId = useAddressableHostId();
  // BOTH methods, because they negotiate independently: the row is an
  // interactive switch, so a host that could answer `get` but not `set` would
  // render a control whose every flip fails. Two statements, not one `&&`:
  // short-circuiting a hook call is a rules-of-hooks violation.
  const getSupported = useHostMethodSupport(hostId, AGENT_BROWSER_ACCESS_GET);
  const setSupported = useHostMethodSupport(hostId, AGENT_BROWSER_ACCESS_SET);
  const supported =
    getSupported === null || setSupported === null
      ? null
      : getSupported && setSupported;

  return (
    <SettingsPanelShell
      title={BROWSER_AGENT_ACCESS.page.label}
      description={BROWSER_AGENT_ACCESS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <SettingsGroup
        group={BROWSER_AGENT_ACCESS.definitions.access}
        showTitle={false}
        tone="default"
        dataTestId="settings-browser-agent-access"
        fill={false}
      >
        {source.kind === "pool" ? (
          <TeamBrowserAccessRow />
        ) : (
          <HostBrowserAccessRow supported={supported} hostId={hostId} />
        )}
      </SettingsGroup>
    </SettingsPanelShell>
  );
}

function HostBrowserAccessRow(props: {
  readonly supported: boolean | null;
  readonly hostId: string | null;
}): ReactNode {
  if (props.supported === true)
    return <AgentBrowserAccessRow hostId={props.hostId} />;
  return (
    <SettingsRow
      row={BROWSER_AGENT_ACCESS.definitions.agentBrowserAccess}
      status={
        props.supported === false
          ? "Update this host to change this setting."
          : undefined
      }
      control={
        <Switch
          checked={false}
          disabled
          aria-label="Let agents use the in-app browser"
        />
      }
    />
  );
}

/**
 * Rendered ONLY under a positive `useHostMethodSupport` for both the getter and
 * the setter, which is what makes `useHostClient()` safe here: a host that
 * advertised the methods has a binding.
 */
function AgentBrowserAccessRow(props: {
  readonly hostId: string | null;
}): ReactNode {
  const client = useHostClient();
  // A blank label is no label - "On ." is not a sentence.
  const label = useHostDirectoryEntry(props.hostId)?.label.trim() ?? "";
  const hostName = label.length > 0 ? label : props.hostId;
  const query = useHostQuery<HostRpcRegistry, "config.browser.get">({
    cacheKeyIdentity: undefined,
    client,
    method: AGENT_BROWSER_ACCESS_GET,
    params: {},
    options: { enabled: true },
  });
  const setAccess = useHostScopedMutationForClient(client, {
    method: AGENT_BROWSER_ACCESS_SET,
    mutationKey: configMutationKeys.browserSet(),
    errorMessage: "Couldn't update agent browser access",
    invalidateMethods: [AGENT_BROWSER_ACCESS_GET],
  });

  return (
    <SettingsRow
      row={BROWSER_AGENT_ACCESS.definitions.agentBrowserAccess}
      status={
        query.isError
          ? "Couldn't read this host's browser setting. Repair Traycer's config.json on that machine, or back it up before resetting it, then reopen Settings."
          : `On ${hostName ?? "this host"}. ${BROWSER_AGENT_ACCESS.definitions.agentBrowserAccess.description} Running agents pick this up on their next turn.`
      }
      control={
        <Switch
          checked={query.data?.agentAccess === true}
          disabled={query.isPending || query.isError || setAccess.isPending}
          aria-label="Let agents use the in-app browser"
          onCheckedChange={(next) => {
            trackSettingChanged("browser-agent-access", "agentBrowserAccess");
            setAccess.mutate({ agentAccess: next });
          }}
        />
      }
    />
  );
}

function TeamBrowserAccessRow(): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanAdministerConfiguration();
  const query = useEnvironmentBrowserAccessQuery(false);
  const { put } = useConfigurationItemMutations();
  const issue =
    put.data === undefined ? null : configurationWriteIssue(put.data);
  let control: ReactNode = null;
  if (query.isPending)
    control = <span className="text-ui-xs text-muted-foreground">Loading</span>;
  else if (query.data !== undefined) {
    control = canEdit ? (
      <Switch
        checked={query.data.agentAccess}
        disabled={put.isPending}
        aria-label="Let agents use the in-app browser"
        onCheckedChange={(enabled) => {
          if (source.kind !== "pool") return;
          put.mutate({
            environmentId: source.environmentId,
            kind: "browser_agent_access",
            key: "browser",
            os: null,
            value: { enabled },
            revision: query.data.revision,
          });
        }}
      />
    ) : (
      <span className="text-ui-sm text-muted-foreground">
        {query.data.agentAccess ? "On" : "Off"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SettingsRow
        row={BROWSER_AGENT_ACCESS.definitions.agentBrowserAccess}
        status={
          query.isError
            ? "Couldn't read this setting."
            : "Running agents pick this up on their next turn."
        }
        control={control}
      />
      <ConfigurationWriteFeedback issue={issue} />
    </div>
  );
}
