import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useConfigurationKey } from "@/components/settings/environment/use-configuration-key";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import { SecretRow } from "@/components/settings/secrets/secret-row";
import { AddSecretDialog } from "@/components/settings/secrets/add-secret-dialog";
import { Button } from "@/components/ui/button";
import { useCanEditConfiguration } from "./configuration-source";
import { ConfigurationReadFailed } from "./team-read-failed";
import { TeamSecretNames } from "./team-secret-names";
import { PROVIDER_KEY_SECRET_NAMES } from "./team-provider-state-word";

/** All provider keys share the selected provider's Key section. */
export function TeamProviderKeys(props: {
  readonly providerId: ProviderId;
}): ReactNode {
  const client = usePoolTierHostClient(useHostClient());
  const queries = useQueryClient();
  const query = useEnvironmentSecretsQuery(client);
  const canEdit = useCanEditConfiguration();
  const configurationKey = useConfigurationKey();
  const [adding, setAdding] = useState(false);
  const keyName = PROVIDER_KEY_SECRET_NAMES[props.providerId];
  const keys =
    query.data?.secrets.filter((secret) => secret.kind === "provider") ?? [];
  // A reader who cannot edit, once the latest read SUCCEEDED. The list's
  // "No secrets." is a claim about the configuration, and there are two states
  // where `keys` is `[]` without that claim being true: while the first read is
  // still out, and when a read failed. Neither is "the configuration has no
  // keys", and on a failure the claim would sit beside the line saying the keys
  // could not be read, contradicting it.
  //
  // `isSuccess` rather than `data !== undefined`, because the two part company
  // exactly where it matters: a poll or refetch that fails AFTER a successful
  // read leaves `data` in place and sets the error, so a guard on data would
  // show the last list — "No secrets." among them — beside that failure line.
  // The editor's list says nothing in these states because an empty list is
  // silent; this one makes a statement, so it has to be withheld.
  const viewerNames = query.isSuccess ? (
    <TeamSecretNames
      secrets={keys.map((secret) => ({
        id: secret.secretId,
        name: secret.name,
        revoked: secret.revoked,
      }))}
    />
  ) : null;
  const reread = (): void => {
    void invalidateEnvironmentReads(queries, ["environment.secrets.list"]);
  };
  return (
    <section
      className="flex min-w-0 flex-col gap-3 wrap-anywhere"
      aria-label="Key"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Key</h2>
        {canEdit && !query.isError && query.data !== undefined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
          >
            Add a key
          </Button>
        ) : null}
      </div>
      {query.isError &&
      query.error instanceof HostMethodVersionUnsatisfiedError ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          These keys need an updated host.
        </p>
      ) : null}
      {query.isError &&
      !(query.error instanceof HostMethodVersionUnsatisfiedError) ? (
        <ConfigurationReadFailed
          page="keys"
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {canEdit ? (
        <ul>
          {keys.map((secret) => (
            <SecretRow
              key={secret.secretId}
              secret={secret}
              client={client}
              hostId={client.getActiveHostId()}
              hostName={() => "a host"}
              onChanged={reread}
            />
          ))}
        </ul>
      ) : (
        viewerNames
      )}
      {canEdit ? (
        <AddSecretDialog
          // Keyed by configuration and provider: a half-filled form stays
          // with the key it was started for.
          key={`${configurationKey}:${props.providerId}`}
          open={adding}
          prefill={keyName === undefined ? null : { name: keyName, value: "" }}
          client={client}
          onOpenChange={setAdding}
          initialKind="provider"
        />
      ) : null}
    </section>
  );
}
