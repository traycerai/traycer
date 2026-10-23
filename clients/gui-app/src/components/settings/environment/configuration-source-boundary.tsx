import { useMemo, type ReactNode } from "react";
import {
  ConfigurationSourceContext,
  configurationRoleOf,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient } from "@/lib/host";

/** A team never mounts its page with the host source while its descriptor loads. */
export function ConfigurationSourceBoundary(props: {
  readonly environmentId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const list = useEnvironmentListQuery(
    useHostClient(),
    props.environmentId !== null,
  );
  const descriptor = list.data?.environments.find(
    (entry) =>
      entry.environmentId === props.environmentId &&
      entry.ownerKind === "organization",
  );
  const source = useMemo<ConfigurationSource>(() => {
    if (descriptor === undefined) return { kind: "host" };
    return {
      kind: "pool",
      environmentId: descriptor.environmentId,
      roomId: descriptor.roomId,
      providerHandle: descriptor.providerHandle,
      effectiveRole: configurationRoleOf(descriptor),
    };
  }, [descriptor]);

  if (props.environmentId !== null && descriptor === undefined) {
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
      <div className="flex flex-col items-start gap-3 p-5">
        <p role="status" className="text-ui-sm text-muted-foreground">
          {list.isError
            ? "Couldn't read these settings."
            : "These settings are no longer available."}
        </p>
        {list.isError ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <ConfigurationSourceContext.Provider value={source}>
      {props.children}
    </ConfigurationSourceContext.Provider>
  );
}
