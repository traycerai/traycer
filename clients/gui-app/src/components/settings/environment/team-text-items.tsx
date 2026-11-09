import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { configurationTextValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import { cn } from "@/lib/utils";
import { useCanEditConfiguration } from "./configuration-source";

import {
  sameConfigurationItemAddress,
  configurationItemDraft,
  failureInScope,
  pendingWriteInScope,
  textWriteScope,
  type ConfigurationItemWrite,
  type ConfigurationItemWriteFailure,
  type ConfigurationItemWrites,
} from "./configuration-item-writes";

import {
  ConfigurationItemWriteStatus,
  ConfigurationItemWriteError,
  ConfigurationPendingWriteStatus,
} from "./configuration-item-write-status";

// Name, value, remove. A team value is a string, so there is no Set or Unset.
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_4.75rem]";
const VALUE_FIELD_PLACEMENT =
  "col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto";
const ROW_ACTIONS_PLACEMENT =
  "col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto sm:justify-self-center";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const scope = textWriteScope(props.kind, props.os, props.providerId);
  const shown = pendingWriteInScope(props.writes, scope);
  const pending = shown?.write ?? null;
  const accepted = shown !== null && shown.accepted !== null;
  const busy = props.writes.pending !== null;
  const failure = failureInScope(props.writes, scope);
  const inventory = textInventory(props.items, pending, props.writes.drafts);
  const newDraft = newTextDraft(props);
  const rows = inventory.filter(scope);
  const [adding, setAdding] = useState(false);
  const showAdd = canEdit && (adding || newDraft.visible !== null);
  const fresh = acceptedNewText(accepted ? pending : null, rows);
  const dismissNew = (): void => {
    if (newDraft.held !== null) props.writes.discardDraft(newDraft.held);
    setAdding(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <ConfigurationItemWriteStatus writes={props.writes} scope={scope} />
      <div className="overflow-hidden rounded-lg border border-border/60">
        <TeamTextHeader />
        {rows.length === 0 && fresh === null && !showAdd ? (
          <p className="px-3 py-5 text-center text-ui-sm text-muted-foreground">
            No variables.
          </p>
        ) : null}
        {rows.length === 0 && fresh === null ? null : (
          <ul className="divide-y divide-border/40">
            {fresh === null ? null : (
              <li>
                <AcceptedNewTextItem write={fresh} />
              </li>
            )}
            {rows.map((item) => (
              <SavedTextRow
                key={savedRowKey(item, pending, accepted, props.writes)}
                item={item}
                items={props.items}
                draft={configurationItemDraft(props.writes, item)}
                failure={failure}
                pending={pending}
                accepted={accepted}
                busy={busy}
                kind={props.kind}
                os={props.os}
                providerId={props.providerId}
                writes={props.writes}
                details={props.renderDetails(item)}
              />
            ))}
          </ul>
        )}
        <TeamTextAddFooter
          showAdd={showAdd}
          canEdit={canEdit}
          busy={busy}
          onAdd={() => setAdding(true)}
          addRow={
            <NewTextRow
              key={`new:${props.kind}:${props.os}:${props.providerId}:${newDraft.held?.key ?? "new"}:${newDraft.visible !== null}`}
              draft={newDraft.visible}
              failure={textRowFailure(null, failure)}
              pending={pending}
              busy={busy}
              kind={props.kind}
              os={props.os}
              providerId={props.providerId}
              writes={props.writes}
              onApplied={() => setAdding(false)}
              onDismiss={dismissNew}
            />
          }
        />
      </div>
    </div>
  );
}

/**
 * Revision stays in the key so a quiet row adopts a newer pool value.
 * That remount does not blur the field, so a dirty value is committed
 * from the editor's unmount instead of being dropped with the old row.
 */
function savedRowKey(
  item: ConfigurationItem,
  pending: ConfigurationItemWrite | null,
  accepted: boolean,
  writes: ConfigurationItemWrites,
): string {
  const draft = configurationItemDraft(writes, item);
  const written = textRowWrite(item, pending) !== null;
  return `${item.os}:${item.key}:${item.revision}:${accepted && written}:${draft !== null}`;
}

function TeamTextAddFooter(props: {
  readonly showAdd: boolean;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly addRow: ReactNode;
}): ReactNode {
  if (props.showAdd) return props.addRow;
  if (!props.canEdit) return null;
  return (
    <div className="border-t border-border/40 px-3 py-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.busy}
        onClick={props.onAdd}
      >
        <Plus className="size-3.5" />
        Add a variable
      </Button>
    </div>
  );
}

function TeamTextHeader(): ReactNode {
  return (
    <div
      className={cn(
        GRID,
        "hidden border-b border-border/40 bg-muted/30 px-3 py-2 text-ui-xs font-medium text-muted-foreground sm:grid",
      )}
    >
      <span>Name</span>
      <span>Value</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

function AcceptedNewTextItem(props: {
  readonly write: ConfigurationItemWrite;
}): ReactNode {
  const value = configurationTextValueSchema.parse(props.write.value).value;
  return (
    <section
      aria-label={props.write.key}
      className="flex flex-col gap-1 px-3 py-2"
    >
      <div className={GRID}>
        <span className="truncate font-mono text-ui-xs text-foreground">
          {props.write.key}
        </span>
        <span
          className={cn(
            VALUE_FIELD_PLACEMENT,
            "truncate font-mono text-ui-xs text-foreground",
          )}
        >
          {value}
        </span>
      </div>
    </section>
  );
}

function acceptedNewText(
  pending: ConfigurationItemWrite | null,
  rows: readonly ConfigurationItem[],
): ConfigurationItemWrite | null {
  if (pending === null || pending.original !== null || pending.action !== "put")
    return null;
  if (rows.some((item) => sameConfigurationItemAddress(item, pending)))
    return null;
  return pending;
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
  return storedName(draft.key, providerId);
}

function storedName(key: string, providerId: string | null): string {
  if (providerId === null) return key;
  const prefix = `${providerId}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
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

function SavedTextRow(props: {
  readonly item: ConfigurationItem;
  readonly items: readonly ConfigurationItem[];
  readonly draft: ConfigurationItemWrite | null;
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly pending: ConfigurationItemWrite | null;
  readonly accepted: boolean;
  readonly busy: boolean;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly providerId: string | null;
  readonly writes: ConfigurationItemWrites;
  readonly details: ReactNode;
}): ReactNode {
  const current =
    props.items.find((item) =>
      sameConfigurationItemAddress(item, props.item),
    ) ?? null;
  const written = textRowWrite(props.item, props.pending) !== null;
  const osLabel =
    props.os === "any" && props.item.os !== null && props.item.os !== "any"
      ? OS_LABELS[props.item.os]
      : null;
  return (
    <li>
      <TeamTextEditor
        item={props.item}
        currentItem={current}
        draft={props.draft}
        failure={textRowFailure(props.item, props.failure)}
        pending={props.pending}
        busy={props.busy}
        onWrite={props.writes.write}
        onDraftChange={props.writes.updateDraft}
        onDiscardDraft={props.writes.discardDraft}
        saving={!props.accepted && written}
        accepted={props.accepted ? written : false}
        kind={props.kind}
        os={props.os}
        osLabel={osLabel}
        providerId={props.providerId}
        details={props.details}
        onApplied={() => undefined}
        onDismiss={() => undefined}
      />
    </li>
  );
}

function NewTextRow(props: {
  readonly draft: ConfigurationItemWrite | null;
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly pending: ConfigurationItemWrite | null;
  readonly busy: boolean;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly providerId: string | null;
  readonly writes: ConfigurationItemWrites;
  readonly onApplied: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const written = textRowWrite(null, props.pending) !== null;
  return (
    <TeamTextEditor
      item={null}
      currentItem={null}
      draft={props.draft}
      failure={props.failure}
      pending={props.pending}
      busy={props.busy}
      onWrite={props.writes.write}
      onDraftChange={props.writes.updateDraft}
      onDiscardDraft={props.writes.discardDraft}
      saving={written ? props.pending?.original === null : false}
      accepted={false}
      kind={props.kind}
      os={props.os}
      osLabel={null}
      providerId={props.providerId}
      details={null}
      onApplied={props.onApplied}
      onDismiss={props.onDismiss}
    />
  );
}

function TeamTextEditor(props: {
  readonly failure: ConfigurationItemWriteFailure | null;
  readonly item: ConfigurationItem | null;
  readonly currentItem: ConfigurationItem | null;
  readonly draft: ConfigurationItemWrite | null;
  readonly onDraftChange: (draft: ConfigurationItemWrite) => void;
  readonly onDiscardDraft: ConfigurationItemWrites["discardDraft"];
  readonly pending: ConfigurationItemWrite | null;
  readonly busy: boolean;
  readonly onWrite: (write: ConfigurationItemWrite) => Promise<void>;
  readonly saving: boolean;
  readonly accepted: boolean;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly osLabel: string | null;
  readonly providerId: string | null;
  readonly details: ReactNode;
  readonly onApplied: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  const saved = shownText(props.item, props.pending, props.accepted);
  const displayName =
    props.item === null ? "" : storedName(props.item.key, props.providerId);
  const [name, setName] = useState(() =>
    props.item === null
      ? textDraftName(props.draft, props.providerId)
      : displayName,
  );
  const [value, setValue] = useState(() =>
    props.draft === null
      ? saved
      : configurationTextValueSchema.parse(props.draft.value).value,
  );
  const title = props.item?.key ?? "New variable";
  const label = props.osLabel === null ? title : `${title} · ${props.osLabel}`;
  const removing =
    props.saving && props.pending !== null && props.pending.action === "remove";
  const changeValue = (next: string): void => {
    setValue(next);
    if (props.draft !== null)
      props.onDraftChange({ ...props.draft, value: { value: next } });
  };
  const snapshot: SavedTextCommit = {
    item: props.item,
    currentItem: props.currentItem,
    draft: props.draft,
    busy: props.busy,
    name,
    value,
    saved,
    displayName,
    kind: props.kind,
    onDiscardDraft: props.onDiscardDraft,
    onWrite: props.onWrite,
    snapName: setName,
  };
  const snapRef = useRef(snapshot);
  useEffect(() => {
    snapRef.current = snapshot;
  });
  const commitSaved = (): void => {
    commitSavedText(snapshot, true);
  };
  useEffect(
    () => () => {
      commitSavedText(snapRef.current, false);
    },
    [],
  );
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-1 px-3 py-2",
        props.item === null && "border-t border-border/40",
      )}
      aria-label={label}
    >
      {canEdit ? (
        <EditableTextRow
          item={props.item}
          name={name}
          value={value}
          displayName={displayName}
          osLabel={props.osLabel}
          busy={props.busy}
          removing={removing}
          canRemove={props.currentItem !== null || removing}
          onName={setName}
          onValue={changeValue}
          onCommit={props.item === null ? () => undefined : commitSaved}
          onRemove={() => {
            if (props.item === null || props.currentItem === null) return;
            void props.onWrite({
              kind: props.kind,
              key: props.item.key,
              os: props.item.os,
              action: "remove",
              value: { value: saved },
              original: props.currentItem,
            });
          }}
          onApply={() => {
            if (props.busy || !NAME_PATTERN.test(name.trim())) return;
            const key =
              props.providerId === null
                ? name.trim()
                : `${props.providerId}:${name.trim()}`;
            const write: ConfigurationItemWrite = {
              kind: props.kind,
              key,
              os: props.os,
              action: "put",
              value: { value },
              original: null,
            };
            if (
              props.draft !== null &&
              !sameConfigurationItemAddress(props.draft, write)
            )
              props.onDiscardDraft(props.draft);
            props.onApplied();
            void props.onWrite(write);
          }}
          onDismiss={props.onDismiss}
        />
      ) : (
        <ReadOnlyTextRow
          name={displayName}
          value={saved}
          osLabel={props.osLabel}
        />
      )}
      <ConfigurationPendingWriteStatus
        write={props.saving ? props.pending : null}
      />
      <ConfigurationItemWriteError failure={props.failure} />
      {props.details === null ? null : (
        <div className="flex justify-end">{props.details}</div>
      )}
    </section>
  );
}

interface SavedTextCommit {
  readonly item: ConfigurationItem | null;
  readonly currentItem: ConfigurationItem | null;
  readonly draft: ConfigurationItemWrite | null;
  readonly busy: boolean;
  readonly name: string;
  readonly value: string;
  readonly saved: string;
  readonly displayName: string;
  readonly kind: "variable" | "env_override";
  readonly onDiscardDraft: ConfigurationItemWrites["discardDraft"];
  readonly onWrite: (write: ConfigurationItemWrite) => Promise<void>;
  readonly snapName: (name: string) => void;
}

/**
 * A saved row's value, on blur and when the row unmounts. A revision change
 * remounts the row without a blur, so the unmount writes a dirty value.
 * The name snap stays on blur: a saved name is not a rename.
 */
function commitSavedText(snap: SavedTextCommit, snapName: boolean): void {
  if (snap.item === null) return;
  if (snapName && snap.name.trim() !== snap.displayName) {
    snap.snapName(snap.displayName);
  }
  if (snap.busy || snap.value === snap.saved) return;
  putText({
    kind: snap.kind,
    draft: snap.draft,
    onDiscardDraft: snap.onDiscardDraft,
    onWrite: snap.onWrite,
    key: snap.item.key,
    os: snap.item.os,
    value: snap.value,
    original: snap.currentItem,
  });
}

function putText(input: {
  readonly kind: "variable" | "env_override";
  readonly draft: ConfigurationItemWrite | null;
  readonly onDiscardDraft: ConfigurationItemWrites["discardDraft"];
  readonly onWrite: (write: ConfigurationItemWrite) => Promise<void>;
  readonly key: string;
  readonly os: EnvironmentOs | null;
  readonly value: string;
  readonly original: ConfigurationItem | null;
}): void {
  const write: ConfigurationItemWrite = {
    kind: input.kind,
    key: input.key,
    os: input.os,
    action: "put",
    value: { value: input.value },
    original: input.original,
  };
  if (input.draft !== null && !sameConfigurationItemAddress(input.draft, write))
    input.onDiscardDraft(input.draft);
  void input.onWrite(write);
}

function textRowFailure(
  item: ConfigurationItem | null,
  failure: ConfigurationItemWriteFailure | null,
): ConfigurationItemWriteFailure | null {
  if (failure === null || textRowWrite(item, failure.write) === null)
    return null;
  return failure;
}

function textRowWrite(
  item: ConfigurationItem | null,
  pending: ConfigurationItemWrite | null,
): ConfigurationItemWrite | null {
  if (pending === null) return null;
  if (item === null) return pending.original === null ? pending : null;
  return sameConfigurationItemAddress(pending, item) ? pending : null;
}

function EditableTextRow(props: {
  readonly item: ConfigurationItem | null;
  readonly name: string;
  readonly value: string;
  readonly displayName: string;
  readonly osLabel: string | null;
  readonly busy: boolean;
  readonly removing: boolean;
  readonly canRemove: boolean;
  readonly onName: (value: string) => void;
  readonly onValue: (value: string) => void;
  readonly onCommit: () => void;
  readonly onRemove: () => void;
  readonly onApply: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const isNew = props.item === null;
  const valueLabel = isNew
    ? "New variable value"
    : `Value for ${props.displayName}`;
  return (
    <div className={GRID}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          value={props.name}
          disabled={props.busy}
          spellCheck={false}
          aria-label={
            isNew ? "New variable name" : `Name for ${props.displayName}`
          }
          placeholder={isNew ? "NODE_ENV" : undefined}
          className="h-8 min-w-0 flex-1"
          onChange={(event) => props.onName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={props.onCommit}
          font="mono"
          size="xs"
        />
        {props.osLabel === null ? null : (
          <Badge variant="secondary" size="xs">
            {props.osLabel}
          </Badge>
        )}
      </div>
      <Input
        value={props.value}
        disabled={props.busy}
        spellCheck={false}
        aria-label={valueLabel}
        placeholder="value"
        className={cn("h-8 min-w-0", VALUE_FIELD_PLACEMENT)}
        onChange={(event) => props.onValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={props.onCommit}
        font="mono"
        size="xs"
      />
      <TextRowActions
        isNew={isNew}
        canRemove={props.canRemove}
        name={props.name}
        displayName={props.displayName}
        busy={props.busy}
        onApply={props.onApply}
        onDismiss={props.onDismiss}
        onRemove={props.onRemove}
      />
    </div>
  );
}

function TextRowActions(props: {
  readonly isNew: boolean;
  readonly canRemove: boolean;
  readonly name: string;
  readonly displayName: string;
  readonly busy: boolean;
  readonly onApply: () => void;
  readonly onDismiss: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  if (props.isNew)
    return (
      <NewTextActions
        name={props.name}
        busy={props.busy}
        onApply={props.onApply}
        onDismiss={props.onDismiss}
      />
    );
  if (!props.canRemove) return <span className={ROW_ACTIONS_PLACEMENT} />;
  return (
    <TeamTextRemoveButton
      name={props.displayName}
      disabled={props.busy}
      onRemove={props.onRemove}
    />
  );
}

function NewTextActions(props: {
  readonly name: string;
  readonly busy: boolean;
  readonly onApply: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  return (
    <div className={cn(ROW_ACTIONS_PLACEMENT, "flex")}>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={props.busy || !NAME_PATTERN.test(props.name.trim())}
        aria-label="Apply variable"
        onClick={props.onApply}
      >
        <Check className="size-4 text-success-foreground" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={props.busy}
        aria-label="Discard variable"
        onClick={props.onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function ReadOnlyTextRow(props: {
  readonly name: string;
  readonly value: string;
  readonly osLabel: string | null;
}): ReactNode {
  return (
    <div className={GRID}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-ui-xs text-foreground">
          {props.name}
        </span>
        {props.osLabel === null ? null : (
          <Badge variant="secondary" size="xs">
            {props.osLabel}
          </Badge>
        )}
      </span>
      <span
        className={cn(
          VALUE_FIELD_PLACEMENT,
          "truncate font-mono text-ui-xs text-foreground",
        )}
      >
        {props.value}
      </span>
    </div>
  );
}

function TeamTextRemoveButton(props: {
  readonly name: string;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onRemove}
      aria-label={`Remove ${props.name}`}
      className={cn(
        ROW_ACTIONS_PLACEMENT,
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive disabled:opacity-50",
      )}
    >
      <Trash2 className="size-4" />
    </button>
  );
}
