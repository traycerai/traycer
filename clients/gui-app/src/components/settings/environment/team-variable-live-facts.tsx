import { useState, type ReactNode } from "react";
import { TeamViewingHostSwitch } from "./team-viewing-host-picker";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";

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
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 p-3"
      aria-label="Live values"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Live values</h2>
        <TeamViewingHostSwitch open={picking} onOpenChange={setPicking} />
      </div>
      {scope.client === null ? null : (
        <p className="wrap-anywhere text-ui-xs text-muted-foreground">
          Applied on {scope.viewingHost?.hostLabel ?? "this host"}
        </p>
      )}
      {scope.client === null ? (
        <TeamContentNeedsHost
          content="live-values"
          teamName={name}
          onPickHost={() => setPicking(true)}
        />
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-2 text-ui-xs text-muted-foreground">
            {shell.data === undefined ? null : (
              <p className="wrap-anywhere">
                Shell:{" "}
                <code>{[shell.data.path, ...shell.data.args].join(" ")}</code>
              </p>
            )}
            {variables.data?.entries.map((entry) => (
              <p key={entry.key} className="wrap-anywhere">
                <code>{entry.key}</code>: {entry.value ?? "Unset"}
              </p>
            ))}
          </div>
          {shell.isError || variables.isError ? (
            <TeamReadFailed
              message="Couldn't read this host's values."
              onRetry={() => {
                if (shell.isError) void shell.refetch();
                if (variables.isError) void variables.refetch();
              }}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
