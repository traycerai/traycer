import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSecretRemovalV12 } from "@traycer/protocol/host/environment-schemas";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useSecretRemovalRetry } from "@/components/settings/details/use-secret-removal-retry";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { removalWithFailures } from "@/components/settings/secrets/secret-removal-lines";
import { SecretRemovalStatus } from "@/components/settings/secrets/secret-removal-status";
import { useSecretRowActions } from "@/components/settings/secrets/use-secret-row-actions";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * A removed secret on its way to Destroyed. The list moves a secret out of
 * its rows the moment Remove revokes it (`removed`), so without this row it
 * would vanish while a host still holds a copy. It reads "STRIPE_KEY ·
 * Removing · no longer usable · waiting for dev-box to delete its copy ·
 * Retry" (or "dev-box couldn't delete its copy") with Details, and leaves
 * the list at Destroyed. Retry uses the same removal action as Details.
 */
export function RemovedSecretRow(props: {
  readonly removed: {
    readonly id: string;
    readonly name: string;
    readonly removal: EnvironmentSecretRemovalV12;
  };
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
  readonly hostName: (hostId: string) => string;
  readonly onChanged: () => void;
}): ReactNode {
  const { removed } = props;
  const actions = useSecretRowActions({
    client: props.client,
    hostId: props.hostId,
    secret: { secretId: removed.id, currentVersionId: null },
    removing: true,
    onChanged: props.onChanged,
  });
  const environmentId = useDetailsEnvironmentId(props.client);
  const retry = useSecretRemovalRetry(props.client, props.hostId);
  // The versions read is the newer fact: it follows a Retry the list has not.
  // Only the list carries a host's failure.
  const removal = removalWithFailures(
    actions.versions.data?.removal ?? removed.removal,
    removed.removal,
  );
  if (
    removed.removal.outcome === "destroyed" ||
    removal.outcome === "destroyed"
  )
    return null;
  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border/60 py-3 opacity-75 last:border-b-0"
      data-testid="removed-secret-row"
      data-secret-name={removed.name}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="min-w-0 font-mono text-ui-sm text-foreground">
          {removed.name}
        </span>
        <SettingsDetailsButton
          subject={
            environmentId === null
              ? null
              : { environmentId, kind: "secret", key: removed.id }
          }
          title={removed.name}
          controls={null}
        />
      </div>
      <SecretRemovalStatus
        removal={removal}
        hostName={props.hostName}
        pending={retry.pending || environmentId === null}
        onRetry={() => {
          if (environmentId === null) return;
          retry.onRetry({ environmentId, kind: "secret", key: removed.id });
        }}
      />
      {retry.error === null ? null : (
        <p role="alert" className="text-ui-xs text-warning-foreground">
          {retry.error}
        </p>
      )}
    </li>
  );
}
