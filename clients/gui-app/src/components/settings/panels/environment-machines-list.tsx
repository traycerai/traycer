/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentDescriptor,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The machines each of the reader's teams runs bots on (Tracy Bots), as
 * Settings' admin surface - nothing here appears in the bot flow. Per team:
 * its sandboxes, listed to every member and naming no operator ("Team
 * machine"), and the reader's own machines bound to it ("Yours"). Another
 * member's machine is never listed: the host answers only what the reader
 * may see.
 */
export function EnvironmentMachinesList(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly environments: ReadonlyArray<EnvironmentDescriptor>;
  /** The capability gate the caller resolved on the same client's host. */
  readonly enabled: boolean;
}): ReactNode {
  const { client, environments, enabled } = props;
  const teams = environments.filter(
    (environment) => environment.ownerKind === "organization",
  );
  const lists = useEnvironmentHostLists(
    client,
    teams.map((environment) => environment.environmentId),
    enabled,
  );
  const viewerUserId = useAuthStore((s) => s.profile?.userId ?? null);
  if (!enabled || teams.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="environment-machines">
      {teams.map((environment) => (
        <EnvironmentMachines
          key={environment.environmentId}
          environment={environment}
          hosts={
            lists.hostsByEnvironmentId.get(environment.environmentId) ?? null
          }
          failed={lists.failedEnvironmentIds.has(environment.environmentId)}
          onRetry={lists.retryFailed}
          viewerUserId={viewerUserId}
        />
      ))}
    </div>
  );
}

function EnvironmentMachines(props: {
  readonly environment: EnvironmentDescriptor;
  /** `null` while the list has not answered. */
  readonly hosts: ReadonlyArray<EnvironmentHostRecord> | null;
  /** The list was asked for and could not be read. */
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { environment, hosts, failed, onRetry, viewerUserId } = props;
  return (
    <section
      className="flex flex-col gap-1"
      aria-label={`Machines in ${environment.label}`}
      data-testid="environment-machines-group"
      data-environment-id={environment.environmentId}
    >
      <h3 className="text-ui-xs font-medium text-foreground">
        Machines in {environment.label}
      </h3>
      {failed ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="environment-machines-failed"
        >
          Couldn&apos;t load {environment.label}&apos;s machines.{" "}
          <Button type="button" variant="link" size="xs" onClick={onRetry}>
            Retry
          </Button>
        </p>
      ) : (
        <EnvironmentMachineRows
          environmentLabel={environment.label}
          hosts={hosts}
          viewerUserId={viewerUserId}
        />
      )}
    </section>
  );
}

function EnvironmentMachineRows(props: {
  readonly environmentLabel: string;
  readonly hosts: ReadonlyArray<EnvironmentHostRecord> | null;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { environmentLabel, hosts, viewerUserId } = props;
  if (hosts === null) return null;
  if (hosts.length === 0) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        No machines run {environmentLabel}&apos;s bots yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {hosts.map((host) => (
        <li
          key={host.hostId}
          className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground"
          data-testid="environment-machine"
          data-host-id={host.hostId}
        >
          <span className="truncate text-foreground">
            {host.hostLabel ?? "Unnamed machine"}
          </span>
          {host.hostPlatform === null ? null : (
            <span className="truncate">{host.hostPlatform}</span>
          )}
          <MachineOwnerBadge host={host} viewerUserId={viewerUserId} />
        </li>
      ))}
    </ul>
  );
}

function MachineOwnerBadge(props: {
  readonly host: EnvironmentHostRecord;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { host, viewerUserId } = props;
  if (host.kind === "sandbox") {
    return (
      <Badge variant="muted" size="xs">
        Team machine
      </Badge>
    );
  }
  if (viewerUserId !== null && host.enrolledByUserId === viewerUserId) {
    return (
      <Badge variant="muted" size="xs">
        Yours
      </Badge>
    );
  }
  return null;
}
