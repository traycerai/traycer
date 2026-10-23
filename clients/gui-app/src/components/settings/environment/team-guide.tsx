import { useState, type ReactNode } from "react";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";

export function TeamGuide(): ReactNode {
  const scope = useTeamViewingHost();
  const source = useConfigurationSource();
  const name =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const [picking, setPicking] = useState(false);
  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-5">
      <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
      {scope.client === null ? (
        <TeamContentNeedsHost
          content="guide"
          teamName={name}
          onPickHost={() => setPicking(true)}
        />
      ) : (
        <p role="status" className="text-ui-sm text-muted-foreground">
          The guide is loading.
        </p>
      )}
    </section>
  );
}
