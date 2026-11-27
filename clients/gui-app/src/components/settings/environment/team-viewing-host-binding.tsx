import type { ReactNode } from "react";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { TeamViewingHostReadContext } from "@/components/settings/host-scope/team-viewing-host-read-context";

/** Only a host running this team can supply live facts or room files. */
export function TeamViewingHostBinding(props: {
  readonly children: ReactNode;
  readonly unavailable: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const scope = useTeamViewingHost();
  if (binding === null || scope.client === null || scope.viewingHost === null)
    return props.unavailable;
  return (
    <HostRuntimeContext.Provider
      value={{
        ...binding,
        hostId: scope.viewingHost.hostId,
        hostClient: scope.client,
      }}
    >
      <TeamViewingHostReadContext.Provider value>
        {props.children}
      </TeamViewingHostReadContext.Provider>
    </HostRuntimeContext.Provider>
  );
}
