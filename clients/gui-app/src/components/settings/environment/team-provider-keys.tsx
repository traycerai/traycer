import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useHostClient } from "@/lib/host";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import { SecretRow } from "@/components/settings/secrets/secret-row";
import { AddSecretDialog } from "@/components/settings/secrets/add-secret-dialog";
import { Button } from "@/components/ui/button";
import { hostQueryKeys } from "@/lib/query-keys";
import { useCanEditConfiguration } from "./configuration-source";
import { TeamSecretNames } from "./team-secret-names";

export function TeamProviderKeys(): ReactNode {
  const client = usePoolTierHostClient(useHostClient());
  const queries = useQueryClient();
  const query = useEnvironmentSecretsQuery(client);
  const canEdit = useCanEditConfiguration();
  const [adding, setAdding] = useState(false);
  const keys =
    query.data?.secrets.filter((secret) => secret.kind === "provider") ?? [];
  const reread = (): void => {
    void queries.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(
        client.getActiveHostId(),
        "environment.secrets.list",
      ),
    });
  };
  return (
    <section className="flex flex-col gap-3" aria-label="Model provider keys">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Model provider keys</h2>
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
      {query.isError ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          {query.error instanceof HostMethodVersionUnsatisfiedError
            ? "These keys need an updated host."
            : "Couldn't read these keys."}
        </p>
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
        <TeamSecretNames secrets={keys} />
      )}
      {canEdit ? (
        <AddSecretDialog
          open={adding}
          client={client}
          onOpenChange={setAdding}
          initialKind="provider"
        />
      ) : null}
    </section>
  );
}
