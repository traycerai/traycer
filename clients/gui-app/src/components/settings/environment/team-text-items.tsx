import { useState, type ReactNode } from "react";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { configurationTextValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";

interface PendingTextWrite {
  readonly kind: "variable" | "env_override";
  readonly key: string;
  readonly os: EnvironmentOs | null;
  readonly action: "put" | "remove";
  readonly value: string;
  readonly original: ConfigurationItem | null;
  readonly accepted: boolean;
}

interface TextWriteFailure {
  readonly write: PendingTextWrite;
  readonly message: string;
}

const OS_LABELS: Readonly<Record<Exclude<EnvironmentOs, "any">, string>> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

/**
 * Row addresses and revisions come from the pool, never from a live host.
 *
 * `os` is the scope a new item is written under. Under `any` every item of
 * every scope is listed, each one scoped to a single OS labelled with it;
 * under a single OS only that OS's items are.
 */
export function TeamTextItems(props: {
  readonly items: readonly ConfigurationItem[];
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly providerId: string | null;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
  readonly renderDetails: (item: ConfigurationItem) => ReactNode;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put, remove } = useConfigurationItemMutations();
  const [pending, setPending] = useState<PendingTextWrite | null>(null);
  const [failure, setFailure] = useState<TextWriteFailure | null>(null);
  // Revision-keyed editors may remount while a write is in flight. Its
  // settlement belongs to the parent that owns the pending inventory.
  const writeItem = async (write: PendingTextWrite): Promise<boolean> => {
    if (source.kind !== "pool") return false;
    setPending(write);
    setFailure(null);
    const request = {
      environmentId: source.environmentId,
      kind: write.kind,
      key: write.key,
      os: write.os,
      revision: write.original?.revision ?? null,
    };
    let result: EnvironmentConfigurationItemWriteResponse;
    try {
      result = await (write.action === "put"
        ? put.mutateAsync({ ...request, value: { value: write.value } })
        : remove.mutateAsync(request));
    } catch (error) {
      setPending(null);
      setFailure({
        write,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    props.onOutcome(result);
    const accepted = result.outcome === "saved";
    setPending(accepted ? { ...write, accepted } : null);
    return accepted;
  };
  const observed =
    pending !== null &&
    pending.accepted &&
    (pending.action === "remove"
      ? !props.items.some(
          (item) =>
            item.kind === pending.kind &&
            item.key === pending.key &&
            item.os === pending.os,
        )
      : props.items.some(
          (item) =>
            item.kind === pending.kind &&
            item.key === pending.key &&
            item.os === pending.os &&
            configurationTextValueSchema.parse(item.value).value ===
              pending.value,
        ));
  if (observed) setPending(null);
  const inventory = [...props.items];
  if (
    pending?.original !== null &&
    pending?.original !== undefined &&
    !inventory.some(
      (item) =>
        item.kind === pending.kind &&
        item.key === pending.key &&
        item.os === pending.os,
    )
  ) {
    inventory.push(pending.original);
  }
  const rows = inventory.filter(
    (item) =>
      item.kind === props.kind &&
      (props.os === "any" || item.os === props.os) &&
      (props.providerId === null ||
        item.key.startsWith(`${props.providerId}:`)),
  );
  const savingWrite = put.isPending ? pending : null;
  return (
    <div className="flex flex-col gap-3">
      {rows.map((item) => (
        <TeamTextItemEditor
          // A row is kind+key+os, and its key carries any provider prefix;
          // the draft seeds from it once, so a new address must remount.
          key={`${item.os}:${item.key}:${item.revision}`}
          item={item}
          pending={pending}
          onWrite={writeItem}
          saving={textRowWrite(item, savingWrite) !== null}
          failure={failure}
          kind={props.kind}
          os={props.os}
          osLabel={
            props.os === "any" && item.os !== null && item.os !== "any"
              ? OS_LABELS[item.os]
              : null
          }
          providerId={props.providerId}
          details={props.renderDetails(item)}
        />
      ))}
      {rows.length === 0 && pending === null ? (
        <p className="text-ui-sm text-muted-foreground">No variables yet.</p>
      ) : null}
      {canEdit ? (
        <TeamTextItemEditor
          key={`new:${props.kind}:${props.os}:${props.providerId}`}
          item={null}
          pending={pending}
          onWrite={writeItem}
          saving={textRowWrite(null, savingWrite) !== null}
          failure={failure}
          kind={props.kind}
          os={props.os}
          osLabel={null}
          providerId={props.providerId}
          details={null}
        />
      ) : null}
    </div>
  );
}

function TeamTextItemEditor(props: {
  readonly item: ConfigurationItem | null;
  readonly pending: PendingTextWrite | null;
  readonly onWrite: (write: PendingTextWrite) => Promise<boolean>;
  readonly saving: boolean;
  readonly failure: TextWriteFailure | null;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  /** The single OS a row listed under `any` is scoped to, else `null`. */
  readonly osLabel: string | null;
  readonly providerId: string | null;
  readonly details: ReactNode;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  const saved =
    props.item === null
      ? ""
      : configurationTextValueSchema.parse(props.item.value).value;
  const [name, setName] = useState("");
  const [value, setValue] = useState(saved);
  const [accepted, setAccepted] = useState(false);
  const writeError =
    props.failure !== null &&
    textRowWrite(props.item, props.failure.write) !== null
      ? props.failure.message
      : null;
  if (accepted && props.pending === null) {
    if (props.item === null) {
      setName("");
      setValue("");
    }
    setAccepted(false);
  }
  const title = props.item?.key ?? "New variable";
  const label = props.osLabel === null ? title : `${title} · ${props.osLabel}`;
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim());
  const save = (): void => {
    const key =
      props.item?.key ??
      (props.providerId === null
        ? name.trim()
        : `${props.providerId}:${name.trim()}`);
    const write: PendingTextWrite = {
      kind: props.kind,
      key,
      // An item keeps its own scope; only a new one takes the picker's.
      os: props.item === null ? props.os : props.item.os,
      action: "put",
      value,
      original: props.item,
      accepted: false,
    };
    void props.onWrite(write).then(setAccepted);
  };
  const deleteItem = (): void => {
    if (props.item === null) return;
    const write: PendingTextWrite = {
      kind: props.kind,
      key: props.item.key,
      os: props.item.os,
      action: "remove",
      value: saved,
      original: props.item,
      accepted: false,
    };
    void props.onWrite(write);
  };
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      aria-label={label}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-ui-sm">{title}</span>
          {props.osLabel === null ? null : (
            <Badge variant="secondary" size="xs">
              {props.osLabel}
            </Badge>
          )}
        </span>
        {props.details}
      </div>
      {props.item === null ? (
        <Input
          aria-label="Variable name"
          disabled={props.pending !== null}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="NODE_ENV"
        />
      ) : null}
      {canEdit ? (
        <Input
          aria-label={`${label} value`}
          disabled={props.pending !== null}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <span className="font-mono text-ui-sm">{saved}</span>
      )}
      <TeamTextWriteStatus item={props.item} pending={props.pending} />
      {writeError === null ? null : (
        <p role="alert" className="text-ui-xs text-destructive">
          {writeError}
        </p>
      )}
      {canEdit ? (
        <TeamTextActions
          isNew={props.item === null}
          disabled={props.pending !== null}
          canSave={props.item === null ? validName : value !== saved}
          saving={props.saving}
          onSave={save}
          onDelete={deleteItem}
        />
      ) : null}
    </section>
  );
}

/** A status belongs to the complete row address: kind, key and OS. */
function textRowWrite(
  item: ConfigurationItem | null,
  pending: PendingTextWrite | null,
): PendingTextWrite | null {
  if (pending === null) return null;
  if (item === null) return pending.original === null ? pending : null;
  return pending.original?.kind === item.kind &&
    pending.original.key === item.key &&
    pending.original.os === item.os
    ? pending
    : null;
}

function TeamTextActions(props: {
  readonly isNew: boolean;
  readonly disabled: boolean;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  return (
    <div className="flex justify-end gap-2">
      {props.isNew ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          onClick={props.onDelete}
        >
          Delete
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        disabled={props.disabled || !props.canSave}
        onClick={props.onSave}
      >
        {props.isNew ? "Add a variable" : "Save"}
        {props.saving ? <MutedAgentSpinner /> : null}
      </Button>
    </div>
  );
}

function TeamTextWriteStatus(props: {
  readonly item: ConfigurationItem | null;
  readonly pending: PendingTextWrite | null;
}): ReactNode {
  const write = textRowWrite(props.item, props.pending);
  if (write === null) return null;
  let action = props.item === null ? "Adding" : "Saving";
  if (write.action === "remove") action = "Removing";
  return (
    <p role="status" className="text-ui-xs text-muted-foreground">
      {write.key} · {action}
    </p>
  );
}
