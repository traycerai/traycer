import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { AddSecretDialog } from "@/components/settings/secrets/add-secret-dialog";
import { SecretRow } from "@/components/settings/secrets/secret-row";
import { SecretsHeaderDetails } from "@/components/settings/secrets/secrets-header-details";
import { HeldItemsLine } from "@/components/settings/secrets/held-items-line";
import { Button } from "@/components/ui/button";
import { useEnvironmentSecretsQuery } from "@/hooks/environment/team/use-secrets-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { TeamSecretNames } from "@/components/settings/environment/team-secret-names";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  SECRETS_ADD_LABEL,
  SECRETS_EMPTY_TEXT,
  SECRETS_NEED_UPDATED_HOST,
} from "@/lib/sandboxes/secrets-page-copy";

/**
 * Settings ▸ Personal ▸ Secrets on a host that serves `environment.secrets.*`:
 * the person's secrets, read through the window's own host, with Add a secret
 * and each row's Verify. No value is ever read back; a refusal (no session on
 * this computer among them) shows the host's own words.
 */
export function SecretsPage(props: {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  /** A host's name by its id, for the rotation's per-host lines. */
  readonly hostName: (hostId: string) => string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const list = useEnvironmentSecretsQuery(props.client);
  const canEdit = useCanEditConfiguration();
  const source = useConfigurationSource();

  const reread = (): void => {
    for (const method of SECRET_READS) {
      void queryClient
        .invalidateQueries({
          queryKey: hostQueryKeys.methodScope(props.hostId, method),
        })
        .catch(ignoreError);
    }
  };

  const secrets = list.data?.secrets ?? null;
  return (
    <section className="flex flex-col gap-3" data-testid="secrets-page">
      <SecretsHeaderDetails client={props.client} hostId={props.hostId} />
      {source.kind === "host" ? (
        <HeldItemsLine client={props.client} hostId={props.hostId} />
      ) : null}
      {list.isError ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
          data-testid="secrets-page-error"
        >
          <span className="min-w-0 max-w-[72ch]">
            {list.error instanceof HostMethodVersionUnsatisfiedError
              ? SECRETS_NEED_UPDATED_HOST
              : list.error.message}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void list.refetch().catch(ignoreError)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {secrets !== null && secrets.length === 0 ? (
        <p
          className="max-w-[72ch] text-ui-sm text-muted-foreground"
          data-testid="secrets-empty"
        >
          {SECRETS_EMPTY_TEXT}
        </p>
      ) : null}
      {secrets !== null && !canEdit ? (
        <TeamSecretNames secrets={secrets} />
      ) : null}
      {canEdit && secrets !== null && secrets.length > 0 ? (
        <ul className="flex flex-col" data-testid="secrets-list">
          {secrets.map((secret) => (
            <SecretRow
              key={secret.secretId}
              secret={secret}
              client={props.client}
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
          open={adding}
          client={props.client}
          onOpenChange={setAdding}
        />
      ) : null}
    </section>
  );
}
