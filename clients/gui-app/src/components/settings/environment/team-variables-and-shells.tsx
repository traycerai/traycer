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
import { configurationTextValueSchema } from "@/hooks/environment/team/configuration-item-values";
import { configurationShellValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useCanEditConfiguration,
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
import {
  useConfigurationItemWrites,
  sameConfigurationItemAddress,
  configurationItemDraft,
  type ConfigurationItemWrites,
  type ConfigurationItemWrite,
} from "./configuration-item-writes";
import {
  ConfigurationItemWriteStatus,
  ConfigurationItemWriteError,
  ConfigurationPendingWriteStatus,
} from "./configuration-item-write-status";

export function TeamVariablesAndShells(): ReactNode {
  const personal = useConfigurationIsPersonal();
  const query = useConfigurationVariablesQuery();
  const read = useBoundedRead(query);
  const items = query.data;
  const [os, setOs] = useState<EnvironmentOs>("any");
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const outcome = (result: EnvironmentConfigurationItemWriteResponse): void =>
    setIssue(configurationWriteIssue(result));
  const writes = useConfigurationItemWrites(query, outcome);
  const shell =
    items?.find(
      (item) => item.kind === "shell" && item.key === "shell" && item.os === os,
    ) ?? null;
  return (
    <SettingsPanelShell
      title="Variables & shells"
      description={
        personal
          ? "Plain values every computer and sandbox running these settings gets, and the shell agents run in."
          : "Plain values every host running these settings gets, and the shell agents run in."
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
                items={items}
                kind="variable"
                os={os}
                providerId={null}
                writes={writes}
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
                key={`${os}:${shell?.revision ?? "new"}:${acceptedShell(writes, os) !== null}:${shellDraft(writes, os) !== null}`}
                item={shell}
                applied={
                  applied.shell === undefined
                    ? null
                    : { path: applied.shell.path, args: applied.shell.args }
                }
                os={os}
                writes={writes}
              />
            </>
          )}
        </TeamVariableLiveFacts>
      )}
    </SettingsPanelShell>
  );
}

interface ShellValue {
  readonly path: string;
  readonly args: string[];
}

/**
 * The shell the editor shows: an accepted write's value (none after an
 * accepted remove), else the stored item's.
 */
function shownShell(
  item: ConfigurationItem | null,
  accepted: ConfigurationItemWrite | null,
): ShellValue {
  if (accepted?.action === "remove") return { path: "", args: [] };
  if (accepted !== null)
    return configurationShellValueSchema.parse(accepted.value);
  return item === null
    ? { path: "", args: [] }
    : configurationShellValueSchema.parse(item.value);
}

function acceptedShell(
  writes: ConfigurationItemWrites,
  os: EnvironmentOs,
): ConfigurationItemWrite | null {
  const pending = writes.pending;
  if (
    pending === null ||
    pending.accepted === null ||
    !sameConfigurationItemAddress(pending.write, {
      kind: "shell",
      key: "shell",
      os,
    })
  )
    return null;
  return pending.write;
}

function shellDraft(
  writes: ConfigurationItemWrites,
  os: EnvironmentOs,
): ConfigurationItemWrite | null {
  return configurationItemDraft(writes, { kind: "shell", key: "shell", os });
}

function shellDraftState(
  draft: ConfigurationItemWrite | null,
  saved: ShellValue,
): {
  readonly field: "path" | "args" | null;
  readonly value: ShellValue;
} {
  if (draft === null) return { field: null, value: saved };
  return {
    field: draft.draftField === "args" ? "args" : "path",
    value: configurationShellValueSchema.parse(draft.value),
  };
}

function TeamShellEditor(props: {
  readonly item: ConfigurationItem | null;
  readonly applied: {
    readonly path: string;
    readonly args: readonly string[];
  } | null;
  readonly os: EnvironmentOs;
  readonly writes: ConfigurationItemWrites;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  const pending = props.writes.pending;
  const saved = shownShell(props.item, acceptedShell(props.writes, props.os));
  const draft = shellDraft(props.writes, props.os);
  const initial = shellDraftState(draft, saved);
  const [editing, setEditing] = useState<"path" | "args" | null>(initial.field);
  const [path, setPath] = useState(initial.value.path);
  const [args, setArgs] = useState(initial.value.args);
  const updateValue = (value: ShellValue): void => {
    setPath(value.path);
    setArgs(value.args);
    if (draft !== null)
      props.writes.updateDraft({
        ...draft,
        value: { path: value.path, args: value.args },
      });
  };
  const editField = (field: "path" | "args"): void => {
    setEditing(field);
    if (draft !== null)
      props.writes.updateDraft({ ...draft, draftField: field });
  };
  const configured = props.item === null ? null : saved;
  const editingVisible = canEdit && editing !== null;
  const busy = props.writes.pending !== null;
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
            onEdit={() => editField("path")}
            editor={
              <Input
                ref={focusShellPath}
                aria-label="Shell path"
                placeholder="/bin/zsh"
                value={path}
                disabled={busy}
                onChange={(event) =>
                  updateValue({ path: event.target.value, args })
                }
              />
            }
          />
          <AppliedShellValue
            saved={configured?.path ?? null}
            applied={props.applied?.path ?? null}
          />
        </div>
        <ShellRemoveMenu
          item={props.item}
          os={props.os}
          writes={props.writes}
          busy={busy}
          canEdit={canEdit}
        />
        <span className="col-start-1 row-start-2 text-ui-sm">Arguments</span>
        <div className="col-start-2 row-start-2 min-w-0">
          <ShellField
            label="Shell arguments"
            value={args.join(" · ")}
            empty="None"
            canEdit={canEdit}
            busy={busy}
            editing={editing === "args"}
            onEdit={() => editField("args")}
            editor={
              <ShellFlagChips
                args={args}
                disabled={busy}
                onAdd={(flag) => updateValue({ path, args: [...args, flag] })}
                onRemove={(index) =>
                  updateValue({
                    path,
                    args: args.filter((_, i) => i !== index),
                  })
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
      <ShellWriteStatus writes={props.writes} os={props.os} />
      <ShellEditActions
        visible={editingVisible}
        changed={changed}
        path={path}
        busy={busy}
        saving={pending?.write.kind === "shell" && pending.accepted === null}
        onCancel={() => {
          if (draft !== null) props.writes.discardDraft(draft);
          setPath(saved.path);
          setArgs(saved.args);
          setEditing(null);
        }}
        onSave={() => {
          void props.writes.write({
            kind: "shell",
            key: "shell",
            os: props.os,
            action: "put",
            draftField: editing,
            value: { path, args },
            original: props.item,
          });
        }}
      />
    </section>
  );
}

function ShellRemoveMenu(props: {
  readonly item: ConfigurationItem | null;
  readonly os: EnvironmentOs;
  readonly writes: ConfigurationItemWrites;
  readonly busy: boolean;
  readonly canEdit: boolean;
}): ReactNode {
  const item = props.item;
  if (!props.canEdit || item === null) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="More for shell"
          disabled={props.busy}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            void props.writes.write({
              kind: "shell",
              key: "shell",
              os: props.os,
              action: "remove",
              draftField: null,
              value: { path: "", args: [] },
              original: item,
            });
          }}
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShellWriteStatus(props: {
  readonly writes: ConfigurationItemWrites;
  readonly os: EnvironmentOs;
}): ReactNode {
  const pending = props.writes.pending;
  const failure = props.writes.failure;
  const addressedFailure =
    failure !== null &&
    sameConfigurationItemAddress(failure.write, {
      kind: "shell",
      key: "shell",
      os: props.os,
    })
      ? failure
      : null;
  return (
    <>
      <ConfigurationPendingWriteStatus
        write={
          pending?.write.kind === "shell" && pending.accepted === null
            ? pending.write
            : null
        }
      />
      <ConfigurationItemWriteStatus writes={props.writes} kind="shell" />
      <ConfigurationItemWriteError failure={addressedFailure} />
    </>
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
