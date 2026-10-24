import type { ReactNode } from "react";
import { TeamOwnedLine } from "@/components/settings/host-scope/team-owned-line";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { SECRETS } from "@/components/settings/panels/secrets.definitions";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { TEAM_SECRETS_LINE } from "@/lib/sandboxes/secrets-page-copy";

import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useHostClient } from "@/lib/host";
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
  const client = usePoolTierHostClient(useHostClient());
  const canEdit = useCanEditConfiguration();
  const scope = useTeamViewingHost();
  return (
    <SettingsPanelShell
      title={SECRETS.page.label}
      description={SECRETS.page.description}
      headerAction={
        canEdit ? undefined : (
          <span className="text-ui-xs text-muted-foreground">Read-only</span>
        )
      }
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <SecretsPage
        client={client}
        hostId={client.getActiveHostId()}
        hostName={(hostId) =>
          scope.hosts.data?.hosts.find((host) => host.hostId === hostId)
            ?.hostLabel ?? "a host"
        }
      />
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
  let body: ReactNode = null;
  if (teamName !== null) body = <TeamSecretsView teamName={teamName} />;
  else if (supported === true && scope.client !== null) {
    body = (
      <SecretsPage
        client={scope.client}
        hostId={scope.hostId}
        hostName={(hostId) =>
          scope.hosts.find((host) => host.hostId === hostId)?.name ??
          "a sandbox"
        }
      />
    );
  } else if (supported === false) {
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
