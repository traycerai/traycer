import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { AddSecretDialog } from "@/components/settings/secrets/add-secret-dialog";
import { RemovedSecretRow } from "@/components/settings/secrets/removed-secret-row";
import { SecretRow } from "@/components/settings/secrets/secret-row";
import { HeldItemsLine } from "@/components/settings/secrets/held-items-line";
import { Button } from "@/components/ui/button";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { TeamSecretNames } from "@/components/settings/environment/team-secret-names";
import {
  HostMethodVersionUnsatisfiedError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { hostQueryKeys } from "@/lib/query-keys";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useConfigurationName } from "@/components/settings/environment/team-pick-label";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
import {
  PERSONAL_SECRETS_READ_FAILED,
  SECRETS_ADD_LABEL,
  SECRETS_NEED_UPDATED_HOST,
} from "@/lib/sandboxes/secrets-page-copy";

type SecretsList = ResponseOfMethod<
  HostRpcRegistry,
  "environment.secrets.list"
>;

/**
 * The list's rows: the live secrets, `null` until read, and the removed ones
 * not yet destroyed, which keep a row until they are. A removed secret is
 * never shown a second time among the live ones.
 */
function secretRows(list: SecretsList | undefined): {
  readonly secrets: SecretsList["secrets"] | null;
  readonly removing: SecretsList["removed"];
} {
  if (list === undefined) return { secrets: null, removing: [] };
  return {
    secrets: list.secrets.filter(
      (secret) => !list.removed.some((entry) => entry.id === secret.secretId),
    ),
    removing: list.removed.filter(
      (entry) => entry.removal.outcome !== "destroyed",
    ),
  };
}

/**
 * Why the list is not shown: an old host by name, else the configuration's own
 * line. A remote error body is never rendered to the person — it says the
 * server's words ("the destination api.example.com does not resolve"), not
 * what this page could not do.
 */
function readFailureText(
  error: Error | null,
  personal: boolean,
  configurationName: string,
): string {
  if (error instanceof HostMethodVersionUnsatisfiedError) {
    return SECRETS_NEED_UPDATED_HOST;
  }
  if (personal) return PERSONAL_SECRETS_READ_FAILED;
  return `Couldn't read ${configurationName}'s secrets.`;
}

/**
 * The configuration's secrets, read through the serving tier, with Add a
 * secret and each row's Verify for editors. No value is ever read back;
 * refusals stay beside the action that caused them.
 */
export function SecretsPage(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  /** In place of the list when there is no secret: the configuration's text. */
  readonly emptyText: string;
  /** A host's name by its id, for the rotation's per-host lines. */
  readonly hostName: (hostId: string) => string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const configurationClient = usePoolTierHostClient(props.client);
  const list = useEnvironmentSecretsQuery(configurationClient);
  const read = useBoundedRead(list);
  const configurationName = useConfigurationName();
  const canEdit = useCanEditConfiguration();
  const source = useConfigurationSource();
  const configurationKey = useConfigurationKey();

  const reread = (): void => {
    for (const method of SECRET_READS) {
      void queryClient
        .invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostRpcServingTierHostId(
              method,
              props.hostId,
              readProcessHostRpcTierPlan(),
              null,
            ),
            method,
          ),
        })
        .catch(ignoreError);
    }
  };

  // Keep the last answer beside a refetch error instead of replacing its rows
  // with an empty claim while their completion is still unknown.
  const { secrets, removing } = secretRows(list.data);
  const pick = useEnvironmentPick();
  // A Local pick reads this computer's own settings through the window's
  // host: the same Personal page, and no team, so its lines never name one.
  const personal = pick.kind === "personal" || source.kind === "host";
  return (
    <section className="flex flex-col gap-3" data-testid="secrets-page">
      {source.kind === "host" ? (
        <HeldItemsLine client={props.client} hostId={props.hostId} />
      ) : null}
      {read.failed ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
          data-testid="secrets-page-error"
        >
          <span className="min-w-0 max-w-[72ch]">
            {readFailureText(list.error, personal, configurationName)}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={read.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {canEdit &&
      secrets !== null &&
      secrets.length === 0 &&
      removing.length === 0 ? (
        <p
          className="max-w-[72ch] text-ui-sm text-muted-foreground"
          data-testid="secrets-empty"
        >
          {props.emptyText}
        </p>
      ) : null}
      {/* A reader who cannot edit still sees every name and state, the
          removals that have not finished included, or that there are none. */}
      {secrets !== null && !canEdit ? (
        <TeamSecretNames
          secrets={[
            ...secrets,
            ...removing.map((entry) => ({ name: entry.name, revoked: true })),
          ]}
        />
      ) : null}
      {canEdit && secrets !== null && secrets.length + removing.length > 0 ? (
        <ul className="flex flex-col" data-testid="secrets-list">
          {secrets.map((secret) => (
            <SecretRow
              key={secret.secretId}
              secret={secret}
              client={configurationClient}
              hostId={props.hostId}
              hostName={props.hostName}
              onChanged={reread}
            />
          ))}
          {removing.map((entry) => (
            <RemovedSecretRow
              key={entry.id}
              removed={entry}
              client={configurationClient}
              hostId={props.hostId}
              hostName={props.hostName}
              onChanged={reread}
            />
          ))}
        </ul>
      ) : null}
      {secrets === null || !canEdit ? null : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => setAdding(true)}
          data-testid="secrets-add"
        >
          <Plus className="size-3.5" aria-hidden />
          {SECRETS_ADD_LABEL}
        </Button>
      )}
      {canEdit ? (
        <AddSecretDialog
          // Keyed by configuration: a half-filled form stays with the
          // configuration it was started in.
          key={configurationKey}
          open={adding}
          prefill={null}
          client={configurationClient}
          onOpenChange={setAdding}
        />
      ) : null}
    </section>
  );
}
