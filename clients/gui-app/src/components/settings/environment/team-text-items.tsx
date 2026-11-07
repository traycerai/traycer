import { useState, type ReactNode } from "react";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { configurationTextValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import { useCanEditConfiguration } from "./configuration-source";

import {
  sameConfigurationItemAddress,
  configurationItemDraft,
  type ConfigurationItemWrite,
  type ConfigurationItemWriteFailure,
  type ConfigurationItemWrites,
} from "./configuration-item-writes";

import {
  ConfigurationItemWriteStatus,
  ConfigurationItemWriteError,
  ConfigurationPendingWriteStatus,
} from "./configuration-item-write-status";

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
  readonly writes: ConfigurationItemWrites;
  readonly renderDetails: (item: ConfigurationItem) => ReactNode;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  const pending = props.writes.pending?.write ?? null;
  const accepted = props.writes.pending?.accepted !== null && pending !== null;
  const inventory = textInventory(props.items, pending, props.writes.drafts);
  const newDraft = newTextDraft(props);
  const rows = inventory.filter(
    (item) =>
      item.kind === props.kind &&
      (props.os === "any" || item.os === props.os) &&
      (props.providerId === null ||
        item.key.startsWith(`${props.providerId}:`)),
  );

  return (
    <div className="flex flex-col gap-3">
      <ConfigurationItemWriteStatus writes={props.writes} kind={props.kind} />
      <AcceptedNewTextItem
        write={accepted ? pending : null}
        kind={props.kind}
        os={props.os}
        providerId={props.providerId}
      />
      {rows.length === 0 ? null : (
        <div className="rounded-lg border border-border/60">
          {rows.map((item) => {
            const draft = configurationItemDraft(props.writes, item);
            const written = textRowWrite(item, pending) !== null;
            return (
              <TeamTextItemEditor
                // Submitted drafts restore from their owner when the row revision or form mode changes.
                key={`${item.os}:${item.key}:${item.revision}:${accepted && written}:${draft !== null}`}
                item={item}
                currentItem={
                  props.items.find((current) =>
                    sameConfigurationItemAddress(current, item),
                  ) ?? null
                }
                draft={draft}
                onDraftChange={props.writes.updateDraft}
                onDiscardDraft={props.writes.discardDraft}
                failure={textRowFailure(item, props.kind, props.writes.failure)}
                pending={pending}
                onWrite={props.writes.write}
                saving={!accepted && written}
                accepted={accepted ? written : false}
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
            );
          })}
        </div>
      )}
      {rows.length === 0 && pending === null ? (
        <p className="text-ui-sm text-muted-foreground">No variables.</p>
      ) : null}
      {canEdit ? (
        <TeamTextItemEditor
          key={`new:${props.kind}:${props.os}:${props.providerId}:${accepted}:${newDraft.held?.key ?? "new"}:${newDraft.visible !== null}`}
          item={null}
          currentItem={null}
          draft={newDraft.visible}
          onDraftChange={props.writes.updateDraft}
          onDiscardDraft={props.writes.discardDraft}
          failure={textRowFailure(null, props.kind, props.writes.failure)}
          pending={pending}
          onWrite={props.writes.write}
          saving={!accepted && textRowWrite(null, pending) !== null}
          accepted={false}
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

function AcceptedNewTextItem(props: {
  readonly write: ConfigurationItemWrite | null;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly providerId: string | null;
}): ReactNode {
  const write = props.write;
  if (
    write === null ||
    write.original !== null ||
    write.action !== "put" ||
    write.kind !== props.kind ||
    (props.os !== "any" && write.os !== props.os) ||
    (props.providerId !== null && !write.key.startsWith(`${props.providerId}:`))
  )
    return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-3 rounded-lg border border-border/60 p-3 font-mono text-ui-sm wrap-anywhere">
      <span>{write.key}</span>
      <span>{configurationTextValueSchema.parse(write.value).value}</span>
    </div>
  );
}

function newTextDraft(props: {
  readonly items: readonly ConfigurationItem[];
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly providerId: string | null;
  readonly writes: ConfigurationItemWrites;
}): {
  readonly held: ConfigurationItemWrite | null;
  readonly visible: ConfigurationItemWrite | null;
} {
  const held =
    props.writes.drafts.find(
      (draft) =>
        draft.original === null &&
        draft.kind === props.kind &&
        draft.os === props.os &&
        (props.providerId === null ||
          draft.key.startsWith(`${props.providerId}:`)),
    ) ?? null;
  const observed =
    held !== null &&
    props.items.some((item) => sameConfigurationItemAddress(item, held));
  return { held, visible: observed ? null : held };
}

function textInventory(
  items: readonly ConfigurationItem[],
  pending: ConfigurationItemWrite | null,
  drafts: readonly ConfigurationItemWrite[],
): readonly ConfigurationItem[] {
  const inventory = [...items];
  const retained = pending === null ? drafts : [...drafts, pending];
  for (const write of retained) {
    if (
      write.original !== null &&
      !inventory.some((item) => sameConfigurationItemAddress(item, write))
    )
      inventory.push(write.original);
  }
  return inventory;
}

function textDraftName(
  draft: ConfigurationItemWrite | null,
  providerId: string | null,
): string {
  if (draft === null) return "";
  return draft.key.slice(providerId === null ? 0 : providerId.length + 1);
}

function shownText(
  item: ConfigurationItem | null,
  pending: ConfigurationItemWrite | null,
  accepted: boolean,
): string {
  if (accepted && pending?.action === "put")
    return configurationTextValueSchema.parse(pending.value).value;
  return item === null
    ? ""
    : configurationTextValueSchema.parse(item.value).value;
}

function TeamTextItemEditor(props: {
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly item: ConfigurationItem | null;
  readonly currentItem: ConfigurationItem | null;
  readonly draft: ConfigurationItemWrite | null;
  readonly onDraftChange: (draft: ConfigurationItemWrite) => void;
  readonly onDiscardDraft: ConfigurationItemWrites["discardDraft"];
  readonly pending: ConfigurationItemWrite | null;
  readonly onWrite: (write: ConfigurationItemWrite) => Promise<void>;
  readonly saving: boolean;
  readonly accepted: boolean;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  /** The single OS a row listed under `any` is scoped to, else `null`. */
  readonly osLabel: string | null;
  readonly providerId: string | null;
  readonly details: ReactNode;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  const saved = shownText(props.item, props.pending, props.accepted);
  const [name, setName] = useState(() =>
    textDraftName(props.draft, props.providerId),
  );
  const [value, setValue] = useState(() =>
    props.draft === null
      ? saved
      : configurationTextValueSchema.parse(props.draft.value).value,
  );
  const [editing, setEditing] = useState(props.draft?.draftField === "value");
  const title = props.item?.key ?? "New variable";
  const label = props.osLabel === null ? title : `${title} · ${props.osLabel}`;
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim());
  const save = (): void => {
    const key =
      props.item?.key ??
      (props.providerId === null
        ? name.trim()
        : `${props.providerId}:${name.trim()}`);
    const write: ConfigurationItemWrite = {
      kind: props.kind,
      key,
      // An item keeps its own scope; only a new one takes the picker's.
      os: props.item === null ? props.os : props.item.os,
      action: "put",
      draftField: "value",
      value: { value },
      original: props.currentItem,
    };
    if (
      props.draft !== null &&
      !sameConfigurationItemAddress(props.draft, write)
    )
      props.onDiscardDraft(props.draft);
    void props.onWrite(write);
  };
  const deleteItem = (): void => {
    if (props.item === null || props.currentItem === null) return;
    const write: ConfigurationItemWrite = {
      kind: props.kind,
      key: props.item.key,
      os: props.item.os,
      action: "remove",
      draftField: null,
      value: { value: saved },
      original: props.currentItem,
    };
    void props.onWrite(write);
  };
  if (props.item === null && !editing)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.pending !== null}
        onClick={() => setEditing(true)}
      >
        Add variable
      </Button>
    );
  return (
    <section
      className="flex min-w-0 flex-col gap-2 border-b border-border/60 px-3 py-3 last:border-b-0"
      aria-label={label}
    >
      <TeamTextFields
        title={title}
        label={label}
        osLabel={props.osLabel}
        isNew={props.item === null}
        canDelete={props.currentItem !== null || props.saving}
        canEdit={canEdit}
        editing={editing}
        disabled={props.pending !== null}
        name={name}
        value={value}
        saved={saved}
        onName={setName}
        onValue={(next) => {
          setValue(next);
          if (props.draft !== null)
            props.onDraftChange({ ...props.draft, value: { value: next } });
        }}
        onEdit={() => setEditing(true)}
        onDelete={deleteItem}
        details={props.details}
      />
      <ConfigurationPendingWriteStatus
        write={props.saving ? props.pending : null}
      />
      <ConfigurationItemWriteError failure={props.failure} />
      {canEdit && editing ? (
        <TeamTextActions
          isNew={props.item === null}
          disabled={props.pending !== null}
          canSave={props.item === null ? validName : value !== saved}
          saving={props.saving}
          onSave={save}
          onCancel={() => {
            if (props.draft !== null) props.onDiscardDraft(props.draft);
            setValue(saved);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}

function textRowFailure(
  item: ConfigurationItem | null,
  kind: "variable" | "env_override",
  failure: ConfigurationItemWriteFailure | null,
): ConfigurationItemWriteFailure | null {
  if (
    failure === null ||
    failure.write.kind !== kind ||
    textRowWrite(item, failure.write) === null
  )
    return null;
  return failure;
}

/** A status belongs to the complete row address: kind, key and OS. */
function textRowWrite(
  item: ConfigurationItem | null,
  pending: ConfigurationItemWrite | null,
): ConfigurationItemWrite | null {
  if (pending === null) return null;
  if (item === null) return pending.original === null ? pending : null;
  return sameConfigurationItemAddress(pending, item) ? pending : null;
}

function TeamTextActions(props: {
  readonly isNew: boolean;
  readonly disabled: boolean;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="flex justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={props.disabled}
        onClick={props.onCancel}
      >
        Cancel
      </Button>
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

function TeamTextFields(props: {
  readonly title: string;
  readonly label: string;
  readonly osLabel: string | null;
  readonly isNew: boolean;
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly editing: boolean;
  readonly disabled: boolean;
  readonly name: string;
  readonly value: string;
  readonly saved: string;
  readonly onName: (value: string) => void;
  readonly onValue: (value: string) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly details: ReactNode;
}): ReactNode {
  let valueControl: ReactNode = (
    <span className="wrap-anywhere font-mono text-ui-sm">{props.saved}</span>
  );
  if (props.canEdit)
    valueControl = props.editing ? (
      <Input
        ref={props.isNew ? null : focusInput}
        aria-label={`${props.label} value`}
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onValue(event.target.value)}
      />
    ) : (
      <button
        type="button"
        className="w-full cursor-text text-left font-mono text-ui-sm wrap-anywhere"
        aria-label={`Edit ${props.label} value`}
        disabled={props.disabled}
        onClick={() => props.onEdit()}
      >
        {props.saved || "Empty value"}
      </button>
    );
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="wrap-anywhere font-mono text-ui-sm">
          {props.title}
        </span>
        {props.osLabel === null ? null : (
          <Badge variant="secondary" size="xs">
            {props.osLabel}
          </Badge>
        )}
      </span>
      <div className="col-start-1 row-start-2 min-w-0 sm:col-start-2 sm:row-start-1">
        {props.isNew ? (
          <Input
            ref={focusInput}
            aria-label="Variable name"
            disabled={props.disabled}
            value={props.name}
            onChange={(event) => props.onName(event.target.value)}
            placeholder="NODE_ENV"
          />
        ) : null}
        {valueControl}
        {props.details}
      </div>
      {props.canEdit && !props.isNew && props.canDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="col-start-2 row-start-1 sm:col-start-3"
              aria-label={`More for ${props.label}`}
              disabled={props.disabled}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={props.onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function focusInput(node: HTMLInputElement | null): void {
  node?.focus();
}
