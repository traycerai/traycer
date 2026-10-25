import { useMemo, type ReactNode } from "react";
import {
  ConfigurationSourceContext,
  configurationRoleOf,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient } from "@/lib/host";
import { TeamReadFailed } from "./team-read-failed";

/** The configuration a cloud-read page shows: a team's, or Personal. */
export type CloudConfigurationTarget =
  | { readonly kind: "team"; readonly environmentId: string }
  | { readonly kind: "personal" };

/**
 * Pages read `target` from the cloud. Nothing mounts with the host source
 * while its descriptor loads, so a team or Personal page never falls through
 * to the window host's own values.
 */
export function ConfigurationSourceBoundary(props: {
  readonly target: CloudConfigurationTarget;
  readonly children: ReactNode;
}): ReactNode {
  const { target } = props;
  const list = useEnvironmentListQuery(useHostClient(), true);
  const descriptor = list.data?.environments.find((entry) =>
    target.kind === "team"
      ? entry.environmentId === target.environmentId &&
        entry.ownerKind === "organization"
      : entry.ownerKind === "user",
  );
  const source = useMemo<ConfigurationSource>(() => {
    if (descriptor === undefined) return { kind: "host" };
    return {
      kind: "pool",
      configuration: descriptor.ownerKind === "user" ? "personal" : "team",
      environmentId: descriptor.environmentId,
      roomId: descriptor.roomId,
      providerHandle: descriptor.providerHandle,
      effectiveRole: configurationRoleOf(descriptor),
    };
  }, [descriptor]);

  if (descriptor === undefined) {
    if (list.isPending) {
      return (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
      );
    }
    return (
      <div className="p-5">
        {list.isError ? (
          <TeamReadFailed
            message="Couldn't read these settings."
            onRetry={() => void list.refetch()}
          />
        ) : (
          <p role="status" className="text-ui-sm text-muted-foreground">
            These settings are no longer available.
          </p>
        )}
      </div>
    );
  }
  return (
    <ConfigurationSourceContext.Provider value={source}>
      {props.children}
    </ConfigurationSourceContext.Provider>
  );
}
