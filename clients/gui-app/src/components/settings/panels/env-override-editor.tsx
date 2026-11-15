import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  VariableEditSheet,
  VariablePhoneRow,
} from "@/components/settings/variable-edit-sheet";
import { useIsSmallViewport } from "@/hooks/ui/use-small-viewport";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { classifyCredential } from "@traycer/protocol/environment/credential-rule";
import { cn } from "@/lib/utils";

/**
 * Shared inline environment-override editor (Settings → Providers per-provider,
 * and Settings → Shell host-process). One flat, column-aligned table:
 * `Name · Set/Unset value · actions`, with an explicit staged add row; a row
 * on hold reads `NAME · on hold until you choose · Review`, and a saved value
 * that looks like a key shows as dots, never in a field. `value:
 * null` is an explicit unset (drop a variable the process would otherwise
 * inherit). The parent owns the mutations.
 */

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Single grid shared by the header, every row, and the add row so the column
// edges line up exactly (the previous header/rows used different padding). The
// last track is fixed so the row delete button and the add button never shift
// the Name/Value boundaries. Below `sm`, preview rows open an edit sheet and
// the table header hides.
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_4.75rem]";
const VALUE_FIELD_PLACEMENT =
  "col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto";
const ROW_ACTIONS_PLACEMENT =
  "col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto sm:justify-self-center";

type EnvMode = "set" | "unset";

export interface EnvOverrideValue {
  readonly key: string;
  readonly value: string | null;
}

interface PendingEnvWrite {
  readonly oldKey: string;
  readonly key: string;
  readonly action: "put" | "remove";
  readonly original: EnvOverrideValue | null;
}

interface SavedEnvRow {
  readonly key: string;
}

interface Draft {
  readonly key: string;
  readonly value: string;
  readonly mode: EnvMode;
  readonly error: string | null;
}

function modeForValue(value: string | null): EnvMode {
  return value === null ? "unset" : "set";
}

function draftOf(entry: EnvOverrideValue): Draft {
  return {
    key: entry.key,
    value: entry.value ?? "",
    mode: modeForValue(entry.value),
    error: null,
  };
}

function draftShowsEntry(draft: Draft, entry: EnvOverrideValue): boolean {
  return (
    draft.key === entry.key &&
    draft.value === (entry.value ?? "") &&
    draft.mode === modeForValue(entry.value) &&
    draft.error === null
  );
}

/**
 * The latest save of the row named `key` that was refused because the
 * setting changed elsewhere first; `seq` counts refusals so a second one
 * for the same row is seen too.
 */
export interface EnvStaleRefusal {
  readonly key: string;
  readonly seq: number;
}

function isEnvMode(value: string): value is EnvMode {
  return value === "set" || value === "unset";
}

/**
 * Whether a SET value carries leading or trailing whitespace.
 *
 * Surfaced rather than stripped, and the distinction is load-bearing. This
 * value is handed to the spawned CLI byte for byte, and the providers each read
 * it their own way: most treat `"   "` as SET and resolve a directory literally
 * named three spaces under their own cwd, while a few (`claude-code`, `hermes`,
 * reasonix's `REASONIX_HOME`) strip it themselves and treat it as unset. The
 * host models each of those individually so a probe looks where the CLI looks.
 * Normalizing here would make this editor disagree with all of them at once and
 * hide the difference from the only person who can say which they meant - a
 * pasted path with a stray space and a deliberately padded value look identical
 * once trimmed. So: say what will happen, and put the fix one click away.
 */
function hasEdgeWhitespace(value: string): boolean {
  return value !== value.trim();
}

/**
 * The one line below a row: a blocking error if there is one, otherwise the
 * whitespace notice. Shared by the edit row and the add row so the precedence
 * is stated once.
 */
function EnvRowFooter(props: {
  readonly draft: Draft;
  readonly disabled: boolean;
  readonly onTrim: () => void;
}) {
  const { draft, disabled, onTrim } = props;
  if (draft.error !== null) {
    return <p className="text-ui-xs text-destructive">{draft.error}</p>;
  }
  if (draft.mode !== "set" || !hasEdgeWhitespace(draft.value)) return null;
  return <EnvValueWhitespaceNotice disabled={disabled} onTrim={onTrim} />;
}

function EnvValueWhitespaceNotice(props: {
  readonly disabled: boolean;
  readonly onTrim: () => void;
}) {
  const { disabled, onTrim } = props;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-[var(--term-ansi-yellow)]">
      <span>
        Leading or trailing spaces are part of this value — the CLI receives it
        exactly as written.
      </span>
      <button
        type="button"
        disabled={disabled}
        // Keep focus in the field: a blur here would commit the untrimmed value
        // first and this would trim it in a second write.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onTrim}
        className="underline underline-offset-2 hover:no-underline disabled:opacity-50"
      >
        Trim spaces
      </button>
    </p>
  );
}

/** Whether a saved value looks like a key: such a row never shows it. */
function savedKeyShaped(entry: EnvOverrideValue): boolean {
  return (
    entry.value !== null &&
    classifyCredential({ name: entry.key, value: entry.value }).credentialLike
  );
}

function draftError(key: string, otherKeys: readonly string[]): string | null {
  if (!ENV_KEY_PATTERN.test(key)) {
    return "Name must match /^[A-Za-z_][A-Za-z0-9_]*$/.";
  }
  if (otherKeys.includes(key)) return `${key} already exists.`;
  return null;
}

/** Retain only the submitted row, keeping a pending add in its own draft. */
function envRowsWithPending(
  overrides: readonly EnvOverrideValue[],
  pending: PendingEnvWrite | null,
): EnvOverrideValue[] {
  if (pending === null) return [...overrides];
  const rows = overrides.filter(
    (entry) =>
      pending.action !== "put" ||
      pending.oldKey !== "" ||
      entry.key !== pending.key,
  );
  const original = pending.original;
  if (original !== null && !rows.some((entry) => entry.key === original.key))
    rows.push(original);
  return rows;
}

export function EnvOverrideEditor(props: {
  readonly overrides: readonly EnvOverrideValue[];
  readonly disabled: boolean;
  readonly namePlaceholder: string;
  readonly emptyLabel: string;
  /**
   * A short note under a row, by key ("Pending", "dev-box uses: error · Use
   * everywhere"). An empty map for a list with nothing to say.
   */
  readonly rowNotes: ReadonlyMap<string, ReactNode>;
  /** The latest stale refusal of a row's save, or `null` for none. */
  readonly staleRefusal: EnvStaleRefusal | null;
  /**
   * The hosts a SET save propagates to, for the editor's single pending
   * footer ("`<key>` · Applying on `<n>` hosts…"); `null` for a save that
   * reaches only this computer (a Local row, or the Shell host-process
   * caller), which keeps the plain Adding/Saving/Removing text instead.
   */
  readonly applyingHostsCount?: number | null;
  /** Resolves after the write and its post-write overrides read complete. */
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void | Promise<void>;
  /** Resolves after the removal and its post-write overrides read complete. */
  readonly onDelete: (key: string) => void | Promise<void>;
  readonly renderDetails?: (key: string) => ReactNode;
}) {
  const { namePlaceholder, emptyLabel } = props;
  const phone = useIsSmallViewport();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<PendingEnvWrite | null>(null);
  const [savedRow, setSavedRow] = useState<SavedEnvRow | null>(null);
  const submittingRef = useRef(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const disabled = props.disabled || pending !== null;
  // Retain the submitted row until the caller finishes its post-write read.
  const overrides = envRowsWithPending(props.overrides, pending);
  const keys = overrides.map((entry) => entry.key);
  async function submit(
    write: PendingEnvWrite,
    run: () => void | Promise<void>,
  ): Promise<void> {
    if (pending !== null || submittingRef.current) return;
    submittingRef.current = true;
    setPending(write);
    setWriteError(null);
    try {
      await run();
      submittingRef.current = false;
      if (write.oldKey === "" && write.action === "put") setAdding(false);
      setSavedRow({ key: write.oldKey });
      setPending(null);
    } catch (error) {
      submittingRef.current = false;
      setPending(null);
      setWriteError(
        error instanceof Error ? error.message : "Couldn't save this variable.",
      );
    }
  }
  const onCommit = (
    oldKey: string,
    key: string,
    value: string | null,
  ): void => {
    void submit(
      {
        oldKey,
        key,
        action: "put",
        original: props.overrides.find((entry) => entry.key === oldKey) ?? null,
      },
      () => props.onCommit(oldKey, key, value),
    );
  };
  const onDelete = (key: string): void => {
    void submit(
      {
        oldKey: key,
        key,
        action: "remove",
        original: props.overrides.find((entry) => entry.key === key) ?? null,
      },
      () => props.onDelete(key),
    );
  };
  let pendingLabel: string | null = null;
  if (pending !== null) {
    const hostCount = props.applyingHostsCount ?? null;
    if (pending.action === "put" && hostCount !== null) {
      pendingLabel =
        hostCount === 1
          ? `${pending.key} · Applying on 1 host…`
          : `${pending.key} · Applying on ${hostCount} hosts…`;
    } else {
      let action = pending.oldKey === "" ? "Adding" : "Saving";
      if (pending.action === "remove") action = "Removing";
      pendingLabel = `${pending.key} · ${action}`;
    }
  }

  const feedback = (
    <EnvWriteFeedback pendingLabel={pendingLabel} writeError={writeError} />
  );
  // Every phone sheet shows the editor's one write error, so opening or
  // closing a sheet clears it: an error never shows in a sheet it is not from.
  const clearSheetError = (): void => setWriteError(null);

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div
        className={cn(
          GRID,
          // muted-fill-ok: header band inside a border-border/60 container and
          // carrying its own border-b; a collapse loses the tint, not the row
          "hidden border-b border-border/40 bg-muted/30 px-3 py-2 text-ui-xs font-medium text-muted-foreground sm:grid",
        )}
      >
        <span>Name</span>
        <div className="flex items-center gap-2">
          {/* Spacer mirrors the Set/Unset select width (+ gap) so the "Value"
              label sits above the value input, not the action dropdown. */}
          <span className="w-[5.25rem] shrink-0" aria-hidden="true" />
          <span>Value</span>
        </div>
        <span className="sr-only">Actions</span>
      </div>
      {overrides.length === 0 && !adding && pending === null ? (
        <div className="px-3 py-5 text-center text-ui-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : null}
      {overrides.length > 0 ? (
        <ul className="divide-y divide-border/40">
          {overrides.map((entry) => {
            if (savedKeyShaped(entry)) {
              return (
                <EnvMaskedRow
                  phone={phone}
                  feedback={feedback}
                  onSheetToggle={clearSheetError}
                  key={entry.key}
                  entry={entry}
                  disabled={disabled}
                  note={props.rowNotes.get(entry.key) ?? null}
                  details={props.renderDetails?.(entry.key) ?? null}
                  onDelete={onDelete}
                />
              );
            }
            return (
              <EnvOverrideRow
                phone={phone}
                feedback={feedback}
                onSheetToggle={clearSheetError}
                key={entry.key}
                entry={entry}
                otherKeys={keys.filter((k) => k !== entry.key)}
                disabled={disabled}
                note={props.rowNotes.get(entry.key) ?? null}
                details={props.renderDetails?.(entry.key) ?? null}
                staleRefusal={props.staleRefusal}
                savedRow={savedRow}
                onCommit={onCommit}
                onDelete={onDelete}
              />
            );
          })}
        </ul>
      ) : null}
      {adding ? (
        <EnvOverrideAddRow
          phone={phone}
          feedback={feedback}
          existingKeys={keys}
          disabled={disabled}
          namePlaceholder={namePlaceholder}
          onAdd={(key, value) => {
            onCommit("", key, value);
          }}
          onCancel={() => {
            setAdding(false);
            if (phone) clearSheetError();
          }}
        />
      ) : (
        <div className="border-t border-border/40 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setAdding(true);
              if (phone) clearSheetError();
            }}
          >
            <Plus className="size-3.5" />
            Add a variable
          </Button>
        </div>
      )}
      {phone ? null : feedback}
    </div>
  );
}

function EnvWriteFeedback(props: {
  readonly pendingLabel: string | null;
  readonly writeError: string | null;
}): ReactNode {
  return (
    <>
      {props.pendingLabel === null ? null : (
        <p role="status" className="px-3 py-2 text-ui-xs text-muted-foreground">
          {props.pendingLabel}
        </p>
      )}
      {props.writeError === null ? null : (
        <p role="alert" className="px-3 py-2 text-ui-xs text-destructive">
          {props.writeError}
        </p>
      )}
    </>
  );
}

function EnvOverrideRow(props: {
  readonly phone: boolean;
  readonly feedback: ReactNode;
  readonly onSheetToggle: () => void;
  readonly entry: EnvOverrideValue;
  readonly otherKeys: readonly string[];
  readonly disabled: boolean;
  readonly note: ReactNode;
  readonly details: ReactNode;
  readonly staleRefusal: EnvStaleRefusal | null;
  readonly savedRow: SavedEnvRow | null;
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void;
  readonly onDelete: (key: string) => void;
}) {
  const { entry, otherKeys, disabled, onCommit, onDelete } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  // After a completed save or stale refusal, follow the authoritative value
  // until the next edit, so a normalized or superseded draft is not resubmitted.
  const [seenSavedRow, setSeenSavedRow] = useState(props.savedRow);
  const saved =
    props.savedRow !== seenSavedRow && props.savedRow?.key === entry.key;
  if (props.savedRow !== seenSavedRow) setSeenSavedRow(props.savedRow);
  const [following, setFollowing] = useState(false);
  const [seenRefusal, setSeenRefusal] = useState(
    () => props.staleRefusal?.seq ?? 0,
  );
  if (saved) {
    setOpen(false);
    setFollowing(true);
    setDraft(draftOf(entry));
  } else if (
    props.staleRefusal !== null &&
    props.staleRefusal.seq !== seenRefusal
  ) {
    setSeenRefusal(props.staleRefusal.seq);
    if (props.staleRefusal.key === entry.key) {
      setFollowing(true);
      setDraft(draftOf(entry));
    }
  } else if (following && !draftShowsEntry(draft, entry)) {
    setDraft(draftOf(entry));
  }
  const editDraft = (update: (current: Draft) => Draft): void => {
    setFollowing(false);
    setDraft(update);
  };
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const entryRef = useRef(entry);
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);
  const otherKeysRef = useRef(otherKeys);
  useEffect(() => {
    otherKeysRef.current = otherKeys;
  }, [otherKeys]);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const commitValue = (nextValue: string | null): void => {
    const nextKey = draft.key.trim();
    const error = draftError(nextKey, otherKeys);
    if (error !== null) {
      setDraft((current) => ({ ...current, key: entry.key, error }));
      return;
    }
    setDraft((current) => ({ ...current, error: null }));
    if (nextKey !== entry.key || nextValue !== entry.value) {
      onCommit(entry.key, nextKey, nextValue);
    }
  };

  const commit = (): void =>
    commitValue(draft.mode === "unset" ? null : draft.value);

  const trimValue = (): void => {
    const nextValue = draft.value.trim();
    editDraft((current) => ({ ...current, value: nextValue }));
    if (!props.phone) commitValue(nextValue);
  };

  const phoneRef = useRef(props.phone);
  useEffect(() => {
    phoneRef.current = props.phone;
  }, [props.phone]);
  useEffect(() => {
    return () => {
      if (phoneRef.current) return;
      const current = draftRef.current;
      const currentEntry = entryRef.current;
      const nextKey = current.key.trim();
      const nextValue = current.mode === "unset" ? null : current.value;
      const error = draftError(nextKey, otherKeysRef.current);
      if (error !== null) return;
      if (nextKey !== currentEntry.key || nextValue !== currentEntry.value) {
        onCommitRef.current(currentEntry.key, nextKey, nextValue);
      }
    };
  }, []);

  const editor = (
    <>
      <div className={props.phone ? "flex flex-col gap-4" : GRID}>
        <EnvDraftFields
          draft={draft}
          disabled={disabled}
          phone={props.phone}
          nameLabel={`Name for ${entry.key}`}
          valueLabel={`Value for ${entry.key}`}
          onName={(key) => editDraft((current) => ({ ...current, key }))}
          onValue={(value) => editDraft((current) => ({ ...current, value }))}
          onMode={(mode) => editDraft((current) => ({ ...current, mode }))}
          onCommit={commit}
        />
        {props.phone ? null : (
          <RemoveVariableButton
            name={entry.key}
            disabled={disabled}
            onDelete={onDelete}
          />
        )}
      </div>
      <EnvRowNote note={props.note} />
      <EnvRowFooter draft={draft} disabled={disabled} onTrim={trimValue} />
      <EnvRowDetails details={props.details} />
    </>
  );
  if (!props.phone)
    return <li className="flex flex-col gap-1 px-3 py-2">{editor}</li>;
  const dismiss = (): void => {
    if (disabled) return;
    setOpen(false);
    setFollowing(false);
    setDraft(draftOf(entry));
    props.onSheetToggle();
  };
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <VariablePhoneRow
        name={entry.key}
        value={entry.value === null ? "Unset" : entry.value}
        badge={null}
        disabled={disabled}
        onEdit={() => {
          // Open on the stored value and follow it until the first edit, so
          // Save never writes back a value changed while the sheet was shut.
          setFollowing(true);
          setDraft(draftOf(entry));
          setOpen(true);
          props.onSheetToggle();
        }}
      />
      {open ? null : (
        <EnvPhoneRowStatus note={props.note} details={props.details} />
      )}
      <VariableEditSheet
        open={open}
        title={entry.key}
        busy={disabled}
        saveDisabled={false}
        removeLabel={`Remove ${entry.key}`}
        onSave={() => {
          if (draftShowsEntry(draft, entry)) dismiss();
          else commit();
        }}
        onRemove={() => onDelete(entry.key)}
        onDismiss={dismiss}
      >
        {editor}
        {props.feedback}
      </VariableEditSheet>
    </li>
  );
}

/**
 * A saved value that looks like a key: its name, dots in place of the value
 * and Remove.
 */
function EnvMaskedRow(props: {
  readonly phone: boolean;
  readonly feedback: ReactNode;
  readonly onSheetToggle: () => void;
  readonly entry: EnvOverrideValue;
  readonly disabled: boolean;
  readonly note: ReactNode;
  readonly details: ReactNode;
  readonly onDelete: (key: string) => void;
}) {
  const { entry, disabled } = props;
  const [open, setOpen] = useState(false);
  const editor = (
    <>
      <div className={GRID}>
        <span className="truncate font-mono text-ui-xs text-foreground">
          {entry.key}
        </span>
        <span
          className={cn(
            VALUE_FIELD_PLACEMENT,
            "font-mono text-ui-xs text-muted-foreground",
          )}
          aria-label={`${entry.key} is hidden`}
          data-testid="env-masked-value"
        >
          ••••••••
        </span>
        {props.phone ? null : (
          <RemoveVariableButton
            name={entry.key}
            disabled={disabled}
            onDelete={props.onDelete}
          />
        )}
      </div>
      <EnvRowNote note={props.note} />
      <EnvRowDetails details={props.details} />
    </>
  );
  if (!props.phone)
    return (
      <li
        className="flex flex-col gap-1 px-3 py-2"
        data-testid="env-masked-row"
      >
        {editor}
      </li>
    );
  return (
    <li className="flex min-w-0 flex-col gap-1" data-testid="env-masked-row">
      <VariablePhoneRow
        name={entry.key}
        value={
          <span
            aria-label={`${entry.key} is hidden`}
            data-testid="env-masked-value"
          >
            ••••••••
          </span>
        }
        badge={null}
        disabled={disabled}
        onEdit={() => {
          setOpen(true);
          props.onSheetToggle();
        }}
      />
      {open ? null : (
        <EnvPhoneRowStatus note={props.note} details={props.details} />
      )}
      <VariableEditSheet
        open={open}
        title={entry.key}
        busy={disabled}
        saveDisabled
        removeLabel={`Remove ${entry.key}`}
        onSave={null}
        onRemove={() => props.onDelete(entry.key)}
        onDismiss={() => {
          setOpen(false);
          props.onSheetToggle();
        }}
      >
        {editor}
        {props.feedback}
      </VariableEditSheet>
    </li>
  );
}

function EnvRowNote(props: { readonly note: ReactNode }): ReactNode {
  if (props.note === null) return null;
  return (
    <p data-testid="env-row-note" className="text-ui-xs text-muted-foreground">
      {props.note}
    </p>
  );
}

function EnvRowDetails(props: { readonly details: ReactNode }): ReactNode {
  if (props.details === null) return null;
  return <div className="flex justify-end">{props.details}</div>;
}

/**
 * Under a closed phone row: its note and details, as the desktop row shows
 * them. An open sheet shows them in the sheet instead.
 */
function EnvPhoneRowStatus(props: {
  readonly note: ReactNode;
  readonly details: ReactNode;
}): ReactNode {
  if (props.note === null && props.details === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 pb-2">
      <EnvRowNote note={props.note} />
      <EnvRowDetails details={props.details} />
    </div>
  );
}

function RemoveVariableButton(props: {
  readonly name: string;
  readonly disabled: boolean;
  readonly onDelete: (key: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => props.onDelete(props.name)}
      aria-label={`Remove ${props.name}`}
      // muted-fill-ok: hover also swings the icon to text-destructive, so
      // the state keeps a channel that no theme can collapse
      className={cn(
        ROW_ACTIONS_PLACEMENT,
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive disabled:opacity-50",
      )}
    >
      <Trash2 className="size-4" />
    </button>
  );
}

function EnvOverrideAddRow(props: {
  readonly phone: boolean;
  readonly feedback: ReactNode;
  readonly existingKeys: readonly string[];
  readonly disabled: boolean;
  readonly namePlaceholder: string;
  readonly onAdd: (key: string, value: string | null) => void;
  readonly onCancel: () => void;
}) {
  const { existingKeys, disabled, namePlaceholder, onAdd, onCancel } = props;
  const [draft, setDraft] = useState<Draft>(() => ({
    key: "",
    value: "",
    mode: "set",
    error: null,
  }));

  const add = (): void => {
    const nextKey = draft.key.trim();
    const nextValue = draft.mode === "unset" ? null : draft.value;
    const error = draftError(nextKey, existingKeys);
    if (error !== null) {
      setDraft((current) => ({ ...current, error }));
      return;
    }
    onAdd(nextKey, nextValue);
  };

  const editor = (
    <>
      <div className={props.phone ? "flex flex-col gap-4" : GRID}>
        <label
          className={
            props.phone ? "flex w-full flex-col gap-2 text-ui-sm" : "contents"
          }
        >
          {props.phone ? "Name" : null}
          <Input
            value={draft.key}
            disabled={disabled}
            spellCheck={false}
            placeholder={namePlaceholder}
            aria-label="New variable name"
            className="h-8"
            onChange={(event) =>
              setDraft((current) => ({ ...current, key: event.target.value }))
            }
            font="mono"
            size="xs"
          />
        </label>
        <EnvValueField
          multiline={props.phone}
          value={draft.value}
          mode={draft.mode}
          disabled={disabled}
          ariaLabel="New variable value"
          className={VALUE_FIELD_PLACEMENT}
          onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, value }))
          }
          onBlur={() => undefined}
        />
        {props.phone ? null : (
          <div className={cn(ROW_ACTIONS_PLACEMENT, "flex")}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={disabled || draft.key.trim().length === 0}
              aria-label="Apply variable"
              onClick={add}
            >
              <Check className="size-4 text-[var(--term-ansi-green)]" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={disabled}
              aria-label="Discard variable"
              onClick={onCancel}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <EnvRowFooter
        draft={draft}
        disabled={disabled}
        onTrim={() =>
          setDraft((current) => ({ ...current, value: current.value.trim() }))
        }
      />
    </>
  );
  if (!props.phone)
    return (
      <div className="flex flex-col gap-1 border-t border-border/40 px-3 py-2">
        {editor}
      </div>
    );
  return (
    <VariableEditSheet
      open
      title="Add a variable"
      busy={disabled}
      saveDisabled={draft.key.trim().length === 0}
      removeLabel="Remove"
      onRemove={null}
      onSave={add}
      onDismiss={onCancel}
    >
      {editor}
      {props.feedback}
    </VariableEditSheet>
  );
}

function EnvDraftFields(props: {
  readonly draft: Draft;
  readonly disabled: boolean;
  readonly phone: boolean;
  readonly nameLabel: string;
  readonly valueLabel: string;
  readonly onName: (name: string) => void;
  readonly onValue: (value: string) => void;
  readonly onMode: (mode: EnvMode) => void;
  readonly onCommit: () => void;
}): ReactNode {
  // A phone writes only from the sheet's Save, never on blur.
  const onBlur = props.phone ? () => undefined : props.onCommit;
  return (
    <>
      <label
        className={
          props.phone ? "flex w-full flex-col gap-2 text-ui-sm" : "contents"
        }
      >
        {props.phone ? "Name" : null}
        <Input
          value={props.draft.key}
          disabled={props.disabled}
          spellCheck={false}
          aria-label={props.nameLabel}
          className="h-8"
          font="mono"
          size="xs"
          onChange={(event) => props.onName(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <EnvValueField
        multiline={props.phone}
        value={props.draft.value}
        mode={props.draft.mode}
        disabled={props.disabled}
        ariaLabel={props.valueLabel}
        className={VALUE_FIELD_PLACEMENT}
        onModeChange={props.onMode}
        onValueChange={props.onValue}
        onBlur={onBlur}
      />
    </>
  );
}

function EnvValueField(props: {
  readonly multiline: boolean;
  readonly value: string;
  readonly mode: EnvMode;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly className: string;
  readonly onModeChange: (mode: EnvMode) => void;
  readonly onValueChange: (value: string) => void;
  readonly onBlur: () => void;
}) {
  const {
    value,
    mode,
    disabled,
    ariaLabel,
    className,
    onModeChange,
    onValueChange,
    onBlur,
  } = props;
  return (
    <div
      className={cn(
        props.multiline
          ? "flex w-full flex-col gap-2 text-ui-sm"
          : "flex min-w-0 items-center gap-2",
        className,
      )}
    >
      {props.multiline ? "Value" : null}
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(next) => {
          if (isEnvMode(next)) onModeChange(next);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={`${ariaLabel} action`}
          className="h-8 w-[5.25rem] shrink-0"
          onBlur={onBlur}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="set">Set</SelectItem>
          <SelectItem value="unset">Unset</SelectItem>
        </SelectContent>
      </Select>
      {props.multiline ? (
        <Textarea
          value={mode === "unset" ? "" : value}
          disabled={disabled || mode === "unset"}
          spellCheck={false}
          aria-label={ariaLabel}
          placeholder={mode === "unset" ? "not set" : "value"}
          font="mono"
          rows={4}
          onChange={(event) => onValueChange(event.target.value)}
        />
      ) : (
        <Input
          value={mode === "unset" ? "" : value}
          disabled={disabled || mode === "unset"}
          spellCheck={false}
          aria-label={ariaLabel}
          placeholder={mode === "unset" ? "not set" : "value"}
          className="h-8 min-w-0 flex-1"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={onBlur}
          font="mono"
          size="xs"
        />
      )}
    </div>
  );
}
