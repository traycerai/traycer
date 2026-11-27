import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostScopeNotice } from "@/components/settings/host-scope/host-scope-gate";
import { HostUpdateRequiredAction } from "@/components/settings/host-scope/host-update-required-action";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TeamOwnedLine } from "@/components/settings/host-scope/team-owned-line";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { SECRETS } from "@/components/settings/panels/secrets.definitions";
import { isListedSecret } from "@/components/settings/secrets/listed-secrets";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { hostAppVersionFromDirectoryEntry } from "@/lib/host/version-skew-copy";
import { olderHostUpdateVariant } from "@/lib/host/window-narration";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import {
  SECRETS_EMPTY_TEXT,
  TEAM_SECRETS_LINE,
  teamSecretsDescription,
} from "@/lib/sandboxes/secrets-page-copy";
import { useConfigurationName } from "@/components/settings/environment/team-pick-label";

import {
  useCanEditConfiguration,
  useConfigurationIsPersonal,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { environmentReadData } from "@/hooks/environment/environment-read-data";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";

/**
 * Settings > Personal > Secrets, read through the window's own host:
 *
 * - on a host that serves `environment.secrets.list`, the page itself: the
 *   list, Add a secret, Verify (`SecretsPage`);
 * - on a team's host, the team line, and no value is shown here;
 * - under a Local pick of a computer the host lists no longer name, that it
 *   is not connected to this app;
 * - on a host whose version predates the page, that the page is not on it,
 *   with Update now.
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
  const teamDescription = teamSecretsDescription(name);
  return (
    // No Read-only tag: what the reader's role can do is said once, as the
    // page's own standing line, not as a tag over the list.
    <SecretsListPanelShell
      client={client}
      description={personal ? SECRETS.page.description : teamDescription}
      headerAction={undefined}
    >
      <SecretsPage
        client={client}
        hostId={client.getActiveHostId()}
        emptyText={personal ? SECRETS_EMPTY_TEXT : teamDescription}
        hostName={(hostId) =>
          environmentReadData(scope.hosts)?.hosts.find(
            (host) => host.hostId === hostId,
          )?.hostLabel ?? "a host"
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
    !list.data.secrets.some(isListedSecret) &&
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
  const pick = useEnvironmentPick();
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
  else if (pick.kind === "local" && scope.status === "vanished") {
    body = (
      <HostScopeNotice
        tone="idle"
        title={`Not on ${pick.hostName}`}
        detail={`${pick.hostName} isn't connected to this app.`}
        action={null}
        testId="secrets-not-connected"
      />
    );
  } else if (supported === false && scope.host !== null) {
    body = <SecretsNotOnHost host={scope.host} />;
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

/** A host that predates the page: the page is not on it, with Update now. */
function SecretsNotOnHost(props: {
  readonly host: HostScopeOption;
}): ReactNode {
  const { host } = props;
  return (
    <HostScopeNotice
      tone="idle"
      title={`Not on ${host.name}`}
      detail={`Update ${host.name} to use ${SECRETS.page.label}.`}
      action={
        <HostUpdateRequiredAction
          hostId={host.hostId}
          detail={
            olderHostUpdateVariant(
              host.hostId,
              host.isActive,
              hostAppVersionFromDirectoryEntry(host.entry),
            ).detail
          }
          testId="secrets-update-now"
        />
      }
      testId="secrets-update-host"
    />
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
