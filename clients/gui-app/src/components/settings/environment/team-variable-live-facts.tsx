import { useState, type ReactNode } from "react";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { TeamViewingHostSwitch } from "./team-viewing-host-picker";
import { Button } from "@/components/ui/button";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { useConfigurationSource } from "./configuration-source";
import { usePickedTeamLabel } from "./team-pick-label";

import { TeamReadFailed } from "./team-read-failed";

export function TeamVariableLiveFacts(props: {
  readonly children: (values: {
    readonly shell:
      | ResponseOfMethod<HostRpcRegistry, "config.shell.get">
      | undefined;
    readonly variables:
      | ResponseOfMethod<HostRpcRegistry, "config.env.list">
      | undefined;
  }) => ReactNode;
}): ReactNode {
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
  const [details, setDetails] = useState(false);
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h2 className="text-ui-sm font-medium">Variables</h2>
        {scope.client === null ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
            <span className="min-w-0 wrap-anywhere">
              Applied on {scope.viewingHost?.hostLabel ?? "this host"}
            </span>
            <span aria-hidden>·</span>
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              aria-expanded={details}
              onClick={() => setDetails((open) => !open)}
            >
              Details
            </Button>
          </div>
        )}
      </div>
      {scope.client === null ? (
        <>
          <TeamContentNeedsHost
            content="live-values"
            teamName={name}
            onPickHost={() => setPicking(true)}
          />
          <TeamViewingHostSwitch open={picking} onOpenChange={setPicking} />
        </>
      ) : (
        <>
          {details ? (
            <div className="flex min-w-0 flex-col gap-2 text-ui-xs text-muted-foreground">
              <TeamViewingHostSwitch open={picking} onOpenChange={setPicking} />
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
          ) : null}
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
      {props.children({
        shell: scope.client === null ? undefined : shell.data,
        variables: scope.client === null ? undefined : variables.data,
      })}
    </>
  );
}
