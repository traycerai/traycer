import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { TeamOwnedLine } from "@/components/settings/host-scope/team-owned-line";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { SECRETS } from "@/components/settings/panels/secrets.definitions";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  SECRETS_EMPTY_TEXT,
  TEAM_SECRETS_LINE,
  teamSecretsText,
} from "@/lib/sandboxes/secrets-page-copy";

import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useConfigurationName } from "@/components/settings/environment/team-pick-label";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";

/**
 * Settings > Personal > Secrets, read through the window's own host:
 *
 * - on a host that serves `environment.secrets.list`, the page itself: the
 *   list, Add a secret, Verify (`SecretsPage`);
 * - on a team's host, the team line, and no value is shown here;
 * - on a host whose version predates the page, "Update this host to use
 *   your secrets here."
 */
export function SecretsSettingsPanel(): ReactNode {
  const source = useConfigurationSource();
  return source.kind === "pool" ? (
    <TeamSecretsSettingsPanel />
  ) : (
    <HostSecretsSettingsPanel />
  );
}

function TeamSecretsSettingsPanel(): ReactNode {
  const client = useHostClient();
  const personal = useConfigurationIsPersonal();
  const name = useConfigurationName();
  const scope = useTeamViewingHost();
  return (
    // No Read-only tag: what the reader's role can do is said once, as the
    // page's own standing line, not as a tag over the list.
    <SecretsListPanelShell
      client={client}
      description={personal ? SECRETS.page.description : teamSecretsText(name)}
      headerAction={undefined}
    >
      <SecretsPage
        client={client}
        hostId={client.getActiveHostId()}
        emptyText={personal ? SECRETS_EMPTY_TEXT : teamSecretsText(name)}
        hostName={(hostId) =>
          scope.hosts.data?.hosts.find((host) => host.hostId === hostId)
            ?.hostLabel ?? "a host"
        }
      />
    </SecretsListPanelShell>
  );
}

/**
 * The shell over the secrets list. No subtitle while an editor's list is
 * empty: that empty state says the same sentence, and a reader who cannot
 * edit reads "No secrets." instead, so the subtitle stays here for them.
 */
function SecretsListPanelShell(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly description: string;
  readonly headerAction: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  // The read pools the client itself, so the header and the page share one key.
  const list = useEnvironmentSecretsQuery(props.client);
  const canEdit = useCanEditConfiguration();
  // Match the page's retained answer even if a refetch fails: the failure
  // stays beside that content rather than duplicating its empty-state copy.
  const empty =
    canEdit &&
    list.data !== undefined &&
    list.data.secrets.length === 0 &&
    list.data.removed.every((entry) => entry.removal.outcome === "destroyed");
  return (
    <SettingsPanelShell
      title={SECRETS.page.label}
      description={empty ? undefined : props.description}
      headerAction={props.headerAction}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {props.children}
    </SettingsPanelShell>
  );
}

function HostSecretsSettingsPanel(): ReactNode {
  const scope = usePersonalHostScope();
  const supported = useHostMethodSupport(
    scope.hostId,
    "environment.secrets.list",
  );
  const status = useEnvironmentStatusRead(scope.client, scope.hostId, true);
  const principal = status.data?.principal ?? null;
  const teamName = principal?.kind === "team" ? principal.teamName : null;
  if (teamName === null && supported === true && scope.client !== null) {
    return (
      <SecretsListPanelShell
        client={scope.client}
        description={SECRETS.page.description}
        headerAction={undefined}
      >
        <SecretsPage
          client={scope.client}
          hostId={scope.hostId}
          emptyText={SECRETS_EMPTY_TEXT}
          hostName={(hostId) =>
            scope.hosts.find((host) => host.hostId === hostId)?.name ??
            "a sandbox"
          }
        />
      </SecretsListPanelShell>
    );
  }
  let body: ReactNode = null;
  if (teamName !== null) body = <TeamSecretsView teamName={teamName} />;
  else if (supported === false) {
    body = (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="secrets-update-host"
      >
        Update this host to use your secrets here.
      </p>
    );
  }
  return (
    <SettingsPanelShell
      title={SECRETS.page.label}
      description={SECRETS.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      {body}
    </SettingsPanelShell>
  );
}

function TeamSecretsView(props: { readonly teamName: string }): ReactNode {
  return (
    <div className="flex flex-col gap-3" data-testid="secrets-team-view">
      <TeamOwnedLine teamName={props.teamName} />
      <p
        className="max-w-[72ch] text-ui-sm text-muted-foreground"
        data-testid="secrets-team-line"
      >
        {TEAM_SECRETS_LINE}
      </p>
    </div>
  );
}
