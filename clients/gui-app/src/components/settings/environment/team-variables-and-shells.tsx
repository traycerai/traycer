import { useState, type ReactNode } from "react";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { ShellFlagChips } from "@/components/settings/panels/shell/shell-flag-chips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useConfigurationVariablesQuery } from "@/hooks/environment/team/use-variables-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { configurationShellValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
  useConfigurationIsPersonal,
} from "./configuration-source";
import { ConfigurationOsPicker } from "./configuration-os-picker";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  configurationWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { TeamVariableLiveFacts } from "./team-variable-live-facts";
import { TeamTextItems } from "./team-text-items";
import { ConfigurationReadFailed } from "./team-read-failed";
import { usePickedTeamLabel } from "./team-pick-label";

export function TeamVariablesAndShells(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const source = useConfigurationSource();
  const teamName =
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team";
  const query = useConfigurationVariablesQuery();
  const [os, setOs] = useState<EnvironmentOs>("any");
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const outcome = (result: EnvironmentConfigurationItemWriteResponse): void =>
    setIssue(configurationWriteIssue(result));
  const shell =
    query.data?.find(
      (item) => item.kind === "shell" && item.key === "shell" && item.os === os,
    ) ?? null;
  return (
    <SettingsPanelShell
      title="Variables & shells"
      description={
        personal
          ? "Plain values every computer and sandbox running Personal gets, and the shell agents run in."
          : `Plain values every host running ${teamName} gets, and the shell agents run in.`
      }
      bodyClassName="flex flex-col gap-4 overflow-visible rounded-none border-none bg-transparent"
    >
      <ConfigurationOsPicker value={os} onChange={setOs} />
      <ConfigurationWriteFeedback issue={issue} />
      {query.isError ? (
        <ConfigurationReadFailed
          page="variables and shells"
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.isPending ? <MutedAgentSpinner /> : null}
      {query.data === undefined ? null : (
        <>
          <h2 className="text-ui-sm font-medium">Variables</h2>
          <TeamTextItems
            items={query.data}
            kind="variable"
            os={os}
            providerId={null}
            onOutcome={outcome}
            renderDetails={() => null}
          />
          <h2 className="text-ui-sm font-medium">Shell</h2>
          <TeamShellEditor
            key={`${os}:${shell?.revision ?? "new"}`}
            item={shell}
            os={os}
            onOutcome={outcome}
          />
          <TeamVariableLiveFacts />
        </>
      )}
    </SettingsPanelShell>
  );
}

function TeamShellEditor(props: {
  readonly item: ConfigurationItem | null;
  readonly os: EnvironmentOs;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put, remove } = useConfigurationItemMutations();
  const saved =
    props.item === null
      ? { path: "", args: [] }
      : configurationShellValueSchema.parse(props.item.value);
  const [path, setPath] = useState(saved.path);
  const [args, setArgs] = useState(saved.args);
  const changed =
    path !== saved.path || JSON.stringify(args) !== JSON.stringify(saved.args);
  if (!canEdit)
    return (
      <p className="font-mono text-ui-sm">
        {props.item === null
          ? "No shell set."
          : [saved.path, ...saved.args].join(" ")}
      </p>
    );
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <Input
        aria-label="Shell path"
        placeholder="/bin/zsh"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <ShellFlagChips
        args={args}
        disabled={put.isPending || remove.isPending}
        onAdd={(flag) => setArgs([...args, flag])}
        onRemove={(index) => setArgs(args.filter((_, i) => i !== index))}
      />
      <div className="flex justify-end gap-2">
        {props.item === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={put.isPending || remove.isPending}
            onClick={() => {
              if (source.kind === "pool" && props.item !== null)
                remove.mutate(
                  {
                    environmentId: source.environmentId,
                    kind: "shell",
                    key: "shell",
                    os: props.os,
                    revision: props.item.revision,
                  },
                  { onSuccess: props.onOutcome },
                );
            }}
          >
            Remove
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={
            !changed ||
            path.trim().length === 0 ||
            put.isPending ||
            remove.isPending
          }
          onClick={() => {
            if (source.kind === "pool")
              put.mutate(
                {
                  environmentId: source.environmentId,
                  kind: "shell",
                  key: "shell",
                  os: props.os,
                  value: { path, args },
                  revision: props.item?.revision ?? null,
                },
                { onSuccess: props.onOutcome },
              );
          }}
        >
          Save{put.isPending ? <MutedAgentSpinner /> : null}
        </Button>
      </div>
    </section>
  );
}
