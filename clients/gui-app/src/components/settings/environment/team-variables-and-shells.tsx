import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { ShellFlagChips } from "@/components/settings/panels/shell/shell-flag-chips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import { useConfigurationVariablesQuery } from "@/hooks/environment/team/use-variables-query";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { configurationTextValueSchema } from "@/hooks/environment/team/configuration-item-values";
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
  const read = useBoundedRead(query);
  const items = query.data;
  const [os, setOs] = useState<EnvironmentOs>("any");
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const outcome = (result: EnvironmentConfigurationItemWriteResponse): void =>
    setIssue(configurationWriteIssue(result));
  const shell =
    items?.find(
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
      {read.failed ? (
        <ConfigurationReadFailed
          page="variables and shells"
          onRetry={read.retry}
        />
      ) : null}
      {read.pending ? <MutedAgentSpinner /> : null}
      {items === undefined ? null : (
        <TeamVariableLiveFacts>
          {(applied) => (
            <>
              <TeamTextItems
                key={os}
                items={items}
                kind="variable"
                os={os}
                providerId={null}
                onOutcome={outcome}
                renderDetails={(item) => {
                  const entry = applied.variables?.entries.find(
                    (entry) => entry.key === item.key,
                  );
                  const saved = configurationTextValueSchema.parse(
                    item.value,
                  ).value;
                  return entry === undefined || entry.value === saved ? null : (
                    <p className="wrap-anywhere text-ui-xs text-muted-foreground">
                      This host uses {entry.value ?? "Unset"}
                    </p>
                  );
                }}
              />
              <h2 className="text-ui-sm font-medium">Shell</h2>
              <TeamShellEditor
                key={`${os}:${shell?.revision ?? "new"}`}
                item={shell}
                applied={
                  applied.shell === undefined
                    ? null
                    : { path: applied.shell.path, args: applied.shell.args }
                }
                os={os}
                onOutcome={outcome}
              />
            </>
          )}
        </TeamVariableLiveFacts>
      )}
    </SettingsPanelShell>
  );
}

function TeamShellEditor(props: {
  readonly item: ConfigurationItem | null;
  readonly applied: {
    readonly path: string;
    readonly args: readonly string[];
  } | null;
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
  const [editing, setEditing] = useState<"path" | "args" | null>(null);
  const [path, setPath] = useState(saved.path);
  const [args, setArgs] = useState(saved.args);
  const configured = props.item === null ? null : saved;
  const editingVisible = canEdit && editing !== null;
  const busy = put.isPending || remove.isPending;
  const changed =
    path !== saved.path || JSON.stringify(args) !== JSON.stringify(saved.args);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-3">
        <span className="text-ui-sm">Program</span>
        <div className="min-w-0">
          <ShellField
            label="Shell path"
            value={path}
            empty="No shell set."
            canEdit={canEdit}
            busy={busy}
            editing={editing === "path"}
            onEdit={() => setEditing("path")}
            editor={
              <Input
                ref={focusShellPath}
                aria-label="Shell path"
                placeholder="/bin/zsh"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            }
          />
          <AppliedShellValue
            saved={configured?.path ?? null}
            applied={props.applied?.path ?? null}
          />
        </div>
        {canEdit && props.item !== null ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More for shell"
                disabled={busy}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
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
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <span className="col-start-1 row-start-2 text-ui-sm">Arguments</span>
        <div className="col-start-2 row-start-2 min-w-0">
          <ShellField
            label="Shell arguments"
            value={args.join(" · ")}
            empty="None"
            canEdit={canEdit}
            busy={busy}
            editing={editing === "args"}
            onEdit={() => setEditing("args")}
            editor={
              <ShellFlagChips
                args={args}
                disabled={busy}
                onAdd={(flag) => setArgs([...args, flag])}
                onRemove={(index) =>
                  setArgs(args.filter((_, i) => i !== index))
                }
              />
            }
          />
          <AppliedShellValue
            saved={configured?.args.join(" · ") ?? null}
            applied={props.applied?.args.join(" · ") ?? null}
          />
        </div>
      </div>
      <ShellEditActions
        visible={editingVisible}
        changed={changed}
        path={path}
        busy={busy}
        saving={put.isPending}
        onCancel={() => {
          setPath(saved.path);
          setArgs(saved.args);
          setEditing(null);
        }}
        onSave={() => {
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
      />
    </section>
  );
}

function AppliedShellValue(props: {
  readonly saved: string | null;
  readonly applied: string | null;
}): ReactNode {
  if (
    props.saved === null ||
    props.applied === null ||
    props.saved === props.applied
  )
    return null;
  return (
    <p className="wrap-anywhere text-ui-xs text-muted-foreground">
      This host uses {props.applied || "None"}
    </p>
  );
}

function ShellField(props: {
  readonly label: string;
  readonly value: string;
  readonly empty: string;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly editor: ReactNode;
}): ReactNode {
  if (!props.canEdit)
    return (
      <span className="font-mono text-ui-sm wrap-anywhere">
        {props.value || props.empty}
      </span>
    );
  if (props.editing) return props.editor;
  return (
    <button
      type="button"
      className="w-full text-left font-mono text-ui-sm wrap-anywhere"
      aria-label={`Edit ${props.label}`}
      disabled={props.busy}
      onClick={props.onEdit}
    >
      {props.value || props.empty}
    </button>
  );
}

function ShellEditActions(props: {
  readonly visible: boolean;
  readonly changed: boolean;
  readonly path: string;
  readonly busy: boolean;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}): ReactNode {
  if (!props.visible) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={props.busy}
        onClick={props.onCancel}
      >
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={
          !props.changed || props.path.trim().length === 0 || props.busy
        }
        onClick={props.onSave}
      >
        Save{props.saving ? <MutedAgentSpinner /> : null}
      </Button>
    </div>
  );
}

function focusShellPath(node: HTMLInputElement | null): void {
  node?.focus();
}
