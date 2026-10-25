import { useState, type ReactNode } from "react";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { Button } from "@/components/ui/button";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { TeamReadFailed } from "./team-read-failed";

export function TeamVariableLiveFacts(): ReactNode {
  const source = useConfigurationSource();
  const scope = useTeamViewingHost();
  const name =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const [picking, setPicking] = useState(false);
  const shell = useHostQuery({
    client: scope.client,
    cacheKeyIdentity: undefined,
    method: "config.shell.get",
    params: {},
    options: { enabled: scope.client !== null },
  });
  const variables = useHostQuery({
    client: scope.client,
    cacheKeyIdentity: undefined,
    method: "config.env.list",
    params: {},
    options: { enabled: scope.client !== null },
  });
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Live values</h2>
        <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
      </div>
      {scope.client === null ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Live values need a host running {name}.{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => setPicking(true)}
          >
            Pick one.
          </Button>
        </p>
      ) : (
        <>
          {shell.isError || variables.isError ? (
            <TeamReadFailed
              message="Couldn't read this host's values."
              onRetry={() => {
                if (shell.isError) void shell.refetch();
                if (variables.isError) void variables.refetch();
              }}
            />
          ) : null}
          {shell.data === undefined ? null : (
            <p className="text-ui-sm">
              {scope.viewingHost?.hostLabel ?? "This host"} uses:{" "}
              <code>{[shell.data.path, ...shell.data.args].join(" ")}</code>
            </p>
          )}
          {variables.data?.entries.map((entry) => (
            <p key={entry.key} className="text-ui-xs">
              <code>{entry.key}</code>: {entry.value ?? "Unset"}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
