import type { ReactNode } from "react";
import { SecretsDashboardLink } from "@/components/providers/secrets-dashboard-link";
import { TeamOwnedLine } from "@/components/settings/host-scope/team-owned-line";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { SECRETS } from "@/components/settings/panels/secrets.definitions";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsRow } from "@/components/settings/settings-row";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { TEAM_SECRETS_LINE } from "@/lib/sandboxes/secrets-page-copy";

/**
 * Settings > Personal > Secrets, read through the window's own host:
 *
 * - on a host that serves `environment.secrets.list`, the page itself: the
 *   list, Add a secret, Verify (`SecretsPage`);
 * - on a team's host, the team line: team secrets are kept and changed in
 *   the dashboard, and no value is shown here;
 * - on a host whose version predates the page, the way to the dashboard's
 *   Secrets page, as before.
 */
export function SecretsSettingsPanel(): ReactNode {
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
  } else if (supported === false) body = <SecretsDashboardGroup />;
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

function SecretsDashboardGroup(): ReactNode {
  return (
    <SettingsGroup
      group={SECRETS.definitions.dashboard}
      showTitle={false}
      tone="default"
      dataTestId="settings-secrets"
      fill={false}
    >
      <SettingsRow
        row={SECRETS.definitions.manageSecrets}
        control={
          <SecretsDashboardLink
            testId="settings-secrets-dashboard-link"
            className={undefined}
          />
        }
      />
    </SettingsGroup>
  );
}
