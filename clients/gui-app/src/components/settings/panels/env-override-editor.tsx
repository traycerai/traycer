import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { classifyCredential } from "@traycer/protocol/environment/credential-rule";
import {
  isCredentialShapedEnvName,
  urlCarriesCredentials,
} from "@/components/providers/credential-bearing-values";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
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
// the Name/Value boundaries. Below `sm` the three columns can't fit, so rows
// restack onto two lines - name + actions, then the value field full-width
// (see VALUE_FIELD_PLACEMENT / ROW_ACTIONS_PLACEMENT) - and the header hides.
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

interface Draft {
  readonly key: string;
  readonly value: string;
  readonly mode: EnvMode;
  readonly error: string | null;
  /** Refused because the value looks like a key; the row offers Secrets. */
  readonly keyShaped: boolean;
}

/**
 * What a row says when its value looks like a key, and where its link takes
 * the name and value: Add a secret, or a provider's Account tab for that
 * provider's own key.
 */
export interface KeyRefusal {
  /** The line, with its link between `before` and `after`. */
  readonly before: string;
  readonly link: string;
  readonly after: string;
  /** The value is cleared from the field rather than carried on. */
  readonly clearsValue: boolean;
  readonly onLink: (name: string, value: string) => void;
}

/** The refusal for a variable's name; `null` where nothing is refused. */
export type KeyRefusalFor = ((name: string) => KeyRefusal) | null;

function modeForValue(value: string | null): EnvMode {
  return value === null ? "unset" : "set";
}

function draftOf(entry: EnvOverrideValue): Draft {
  return {
    key: entry.key,
    value: entry.value ?? "",
    mode: modeForValue(entry.value),
    error: null,
    keyShaped: false,
  };
}

function draftShowsEntry(draft: Draft, entry: EnvOverrideValue): boolean {
  return (
    draft.key === entry.key &&
    draft.value === (entry.value ?? "") &&
    draft.mode === modeForValue(entry.value) &&
    draft.error === null &&
    !draft.keyShaped
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
  readonly keyRefusal: KeyRefusalFor;
  /** The link handed the value on: the row drops its draft. */
  readonly onRefusalFollowed: () => void;
}) {
  const { draft, disabled, onTrim } = props;
  if (draft.keyShaped && props.keyRefusal !== null) {
    const name = draft.key.trim();
    return (
      <KeyRefusalLine
        refusal={props.keyRefusal(name)}
        disabled={disabled}
        onLink={(refusal) => {
          refusal.onLink(name, draft.value);
          props.onRefusalFollowed();
        }}
      />
    );
  }
  if (draft.error !== null) {
    return <p className="text-ui-xs text-destructive">{draft.error}</p>;
  }
  if (draft.mode !== "set" || !hasEdgeWhitespace(draft.value)) return null;
  return <EnvValueWhitespaceNotice disabled={disabled} onTrim={onTrim} />;
}

function KeyRefusalLine(props: {
  readonly refusal: KeyRefusal;
  readonly disabled: boolean;
  readonly onLink: (refusal: KeyRefusal) => void;
}) {
  const { refusal } = props;
  return (
    <p className="text-ui-xs text-destructive" data-testid="env-key-refusal">
      {refusal.before}
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        disabled={props.disabled}
        onClick={() => props.onLink(refusal)}
      >
        {refusal.link}
      </Button>
      {refusal.after}
    </p>
  );
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

/**
 * Whether a saved value looks like a key: such a row never shows it, on any
 * page, whether or not the page refuses one being typed.
 */
function savedKeyShaped(entry: EnvOverrideValue): boolean {
  return (
    entry.value !== null &&
    classifyCredential({ name: entry.key, value: entry.value }).credentialLike
  );
}

/** Whether `value` is refused here as a key: only where a handler is set. */
function refusedAsKey(
  key: string,
  value: string | null,
  keyRefusal: KeyRefusalFor,
): boolean {
  return (
    keyRefusal !== null &&
    value !== null &&
    classifyCredential({ name: key, value }).credentialLike
  );
}

function draftError(key: string, otherKeys: readonly string[]): string | null {
  if (!ENV_KEY_PATTERN.test(key)) {
    return "Name must match /^[A-Za-z_][A-Za-z0-9_]*$/.";
  }
  if (otherKeys.includes(key)) return `${key} already exists.`;
  return null;
}

/**
 * Why a variable cannot be sent to a host that takes no credentials
 * (`credentialRefusal` set): a name that looks like a credential's (the
 * host's own rule, mirrored), or a SET value that is a URL carrying a
 * sign-in. The typed name and value stay in the fields.
 */
function credentialError(
  key: string,
  value: string | null,
  credentialRefusal: string | null,
): string | null {
  if (credentialRefusal === null) return null;
  if (isCredentialShapedEnvName(key)) {
    return `${credentialRefusal}: a variable whose name looks like a credential is not stored here.`;
  }
  if (value !== null && urlCarriesCredentials(value)) {
    return `${credentialRefusal}: remove the sign-in from this URL.`;
  }
  return null;
}

export function EnvOverrideEditor(props: {
  readonly overrides: readonly EnvOverrideValue[];
  readonly disabled: boolean;
  /**
   * Set when the host takes no credentials: a value that is a URL with a
   * sign-in is refused with this line instead of being committed.
   */
  readonly credentialRefusal: string | null;
  readonly namePlaceholder: string;
  readonly emptyLabel: string;
  /**
   * A short note under a row, by key ("Pending", "dev-box uses: error · Use
   * everywhere"). An empty map for a list with nothing to say.
   */
  readonly rowNotes: ReadonlyMap<string, ReactNode>;
  /**
   * Rows on hold until the person chooses, by key, each with its `Review`
   * control. Such a row shows its name only, never its value.
   */
  readonly onHold: ReadonlyMap<string, ReactNode>;
  /**
   * Rows a secret sets, by key, each with the secret's name: "NAME · from
   * the secret NAME · Secrets", with no value and nothing to edit here.
   */
  readonly claimedBy: ReadonlyMap<string, string>;
  /**
   * Set where a value that looks like a key must not be stored as a
   * variable: such a value is refused in its row with the refusal for its
   * name, whose link takes the name and value on.
   */
  readonly keyRefusal: KeyRefusalFor;
  /** The latest stale refusal of a row's save, or `null` for none. */
  readonly staleRefusal: EnvStaleRefusal | null;
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void;
  readonly onDelete: (key: string) => void;
  readonly renderDetails?: (key: string) => ReactNode;
}) {
  const {
    overrides,
    disabled,
    credentialRefusal,
    namePlaceholder,
    emptyLabel,
    onCommit,
    onDelete,
  } = props;
  const keys = overrides.map((entry) => entry.key);
  const [adding, setAdding] = useState(false);

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
      {overrides.length === 0 && !adding ? (
        <div className="px-3 py-5 text-center text-ui-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : null}
      {overrides.length > 0 ? (
        <ul className="divide-y divide-border/40">
          {overrides.map((entry) => {
            const review = props.onHold.get(entry.key);
            if (review !== undefined) {
              return (
                <EnvHeldRow key={entry.key} name={entry.key} review={review} />
              );
            }
            const secretName = props.claimedBy.get(entry.key);
            if (secretName !== undefined) {
              return (
                <EnvClaimedRow
                  key={entry.key}
                  name={entry.key}
                  secretName={secretName}
                />
              );
            }
            if (savedKeyShaped(entry)) {
              return (
                <EnvMaskedRow
                  key={entry.key}
                  entry={entry}
                  disabled={disabled}
                  keyRefusal={props.keyRefusal}
                  note={props.rowNotes.get(entry.key) ?? null}
                  details={props.renderDetails?.(entry.key) ?? null}
                  onDelete={onDelete}
                />
              );
            }
            return (
              <EnvOverrideRow
                key={entry.key}
                entry={entry}
                otherKeys={keys.filter((k) => k !== entry.key)}
                disabled={disabled}
                credentialRefusal={credentialRefusal}
                keyRefusal={props.keyRefusal}
                note={props.rowNotes.get(entry.key) ?? null}
                details={props.renderDetails?.(entry.key) ?? null}
                staleRefusal={props.staleRefusal}
                onCommit={onCommit}
                onDelete={onDelete}
              />
            );
          })}
        </ul>
      ) : null}
      {adding ? (
        <EnvOverrideAddRow
          existingKeys={keys}
          disabled={disabled}
          credentialRefusal={credentialRefusal}
          keyRefusal={props.keyRefusal}
          namePlaceholder={namePlaceholder}
          onAdd={(key, value) => {
            onCommit("", key, value);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="border-t border-border/40 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
            Add a variable
          </Button>
        </div>
      )}
    </div>
  );
}

function EnvOverrideRow(props: {
  readonly entry: EnvOverrideValue;
  readonly otherKeys: readonly string[];
  readonly disabled: boolean;
  readonly credentialRefusal: string | null;
  readonly keyRefusal: KeyRefusalFor;
  readonly note: ReactNode;
  readonly details: ReactNode;
  readonly staleRefusal: EnvStaleRefusal | null;
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void;
  readonly onDelete: (key: string) => void;
}) {
  const { entry, otherKeys, disabled, credentialRefusal, onCommit, onDelete } =
    props;
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  // After this row's save was refused as stale, the draft follows the
  // setting as it is re-read, so the refused value is never shown again nor
  // sent on blur or when the row goes away; the person's next edit ends it.
  const [following, setFollowing] = useState(false);
  const [seenRefusal, setSeenRefusal] = useState(
    props.staleRefusal === null ? 0 : props.staleRefusal.seq,
  );
  if (props.staleRefusal !== null && props.staleRefusal.seq !== seenRefusal) {
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
    setDraft((current) => ({ ...update(current), keyShaped: false }));
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
  const credentialRefusalRef = useRef(credentialRefusal);
  useEffect(() => {
    credentialRefusalRef.current = credentialRefusal;
  }, [credentialRefusal]);
  const keyRefusalRef = useRef(props.keyRefusal);
  useEffect(() => {
    keyRefusalRef.current = props.keyRefusal;
  }, [props.keyRefusal]);

  const commitValue = (nextValue: string | null): void => {
    // A refused draft waits for an edit; its cleared field is no value.
    if (draft.keyShaped) return;
    const nextKey = draft.key.trim();
    const error = draftError(nextKey, otherKeys);
    if (error !== null) {
      setDraft((current) => ({ ...current, key: entry.key, error }));
      return;
    }
    const refused = credentialError(nextKey, nextValue, credentialRefusal);
    if (refused !== null) {
      setDraft((current) => ({ ...current, error: refused }));
      return;
    }
    if (refusedAsKey(nextKey, nextValue, props.keyRefusal)) {
      const cleared = props.keyRefusal?.(nextKey).clearsValue === true;
      setDraft((current) => ({
        ...current,
        value: cleared ? "" : current.value,
        error: null,
        keyShaped: true,
      }));
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
    commitValue(nextValue);
  };

  useEffect(() => {
    return () => {
      const current = draftRef.current;
      if (current.keyShaped) return;
      const currentEntry = entryRef.current;
      const nextKey = current.key.trim();
      const nextValue = current.mode === "unset" ? null : current.value;
      const error = draftError(nextKey, otherKeysRef.current);
      if (error !== null) return;
      if (
        credentialError(nextKey, nextValue, credentialRefusalRef.current) !==
          null ||
        refusedAsKey(nextKey, nextValue, keyRefusalRef.current)
      ) {
        return;
      }
      if (nextKey !== currentEntry.key || nextValue !== currentEntry.value) {
        onCommitRef.current(currentEntry.key, nextKey, nextValue);
      }
    };
  }, []);

  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className={GRID}>
        <Input
          value={draft.key}
          disabled={disabled}
          spellCheck={false}
          aria-label={`Name for ${entry.key}`}
          className="h-8"
          onChange={(event) =>
            editDraft((current) => ({ ...current, key: event.target.value }))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={commit}
          font="mono"
          size="xs"
        />
        <EnvValueField
          value={draft.value}
          mode={draft.mode}
          disabled={disabled}
          ariaLabel={`Value for ${entry.key}`}
          className={VALUE_FIELD_PLACEMENT}
          onModeChange={(mode) =>
            editDraft((current) => ({ ...current, mode }))
          }
          onValueChange={(value) =>
            editDraft((current) => ({ ...current, value }))
          }
          onBlur={commit}
        />
        <RemoveVariableButton
          name={entry.key}
          disabled={disabled}
          onDelete={onDelete}
        />
      </div>
      {props.note === null ? null : (
        <p
          data-testid="env-row-note"
          className="text-ui-xs text-muted-foreground"
        >
          {props.note}
        </p>
      )}
      <EnvRowFooter
        draft={draft}
        disabled={disabled}
        onTrim={trimValue}
        keyRefusal={props.keyRefusal}
        onRefusalFollowed={() => {
          // The value went on; the row shows what is stored.
          setFollowing(false);
          setDraft(draftOf(entry));
        }}
      />
      {props.details === null ? null : (
        <div className="flex justify-end">{props.details}</div>
      )}
    </li>
  );
}

/**
 * A saved value that looks like a key: its name, dots in place of the value
 * and Remove, with the refusal for its name below where the page has one. The
 * value stays saved until the person acts; its link carries it on.
 */
function EnvMaskedRow(props: {
  readonly entry: EnvOverrideValue;
  readonly disabled: boolean;
  readonly keyRefusal: KeyRefusalFor;
  readonly note: ReactNode;
  readonly details: ReactNode;
  readonly onDelete: (key: string) => void;
}) {
  const { entry, disabled } = props;
  return (
    <li className="flex flex-col gap-1 px-3 py-2" data-testid="env-masked-row">
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
        <RemoveVariableButton
          name={entry.key}
          disabled={disabled}
          onDelete={props.onDelete}
        />
      </div>
      {props.note === null ? null : (
        <p
          data-testid="env-row-note"
          className="text-ui-xs text-muted-foreground"
        >
          {props.note}
        </p>
      )}
      {props.keyRefusal === null ? null : (
        <KeyRefusalLine
          refusal={props.keyRefusal(entry.key)}
          disabled={disabled}
          onLink={(refusal) => refusal.onLink(entry.key, entry.value ?? "")}
        />
      )}
      {props.details === null ? null : (
        <div className="flex justify-end">{props.details}</div>
      )}
    </li>
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

function EnvHeldRow(props: {
  readonly name: string;
  readonly review: ReactNode;
}) {
  return (
    <li
      className="px-3 py-2.5 text-ui-sm text-muted-foreground"
      data-testid="env-held-row"
    >
      <span className="font-mono text-foreground">{props.name}</span>
      {" · on hold until you choose · "}
      {props.review}
    </li>
  );
}

/** A variable a secret sets: the secret's, read and changed on Secrets. */
function EnvClaimedRow(props: {
  readonly name: string;
  readonly secretName: string;
}) {
  return (
    <li
      className="px-3 py-2.5 text-ui-sm text-muted-foreground"
      data-testid="env-claimed-row"
    >
      <span className="font-mono text-foreground">{props.name}</span>
      {" · from the secret "}
      <span className="font-mono">{props.secretName}</span>
      {" · "}
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        onClick={() => navigateToSettingsSection("secrets")}
      >
        Secrets
      </Button>
    </li>
  );
}

function EnvOverrideAddRow(props: {
  readonly existingKeys: readonly string[];
  readonly disabled: boolean;
  readonly credentialRefusal: string | null;
  readonly keyRefusal: KeyRefusalFor;
  readonly namePlaceholder: string;
  readonly onAdd: (key: string, value: string | null) => void;
  readonly onCancel: () => void;
}) {
  const {
    existingKeys,
    disabled,
    credentialRefusal,
    namePlaceholder,
    onAdd,
    onCancel,
  } = props;
  const [draft, setDraft] = useState<Draft>(() => ({
    key: "",
    value: "",
    mode: "set",
    error: null,
    keyShaped: false,
  }));
  const edit = (update: (current: Draft) => Draft): void =>
    setDraft((current) => ({ ...update(current), keyShaped: false }));

  const add = (): void => {
    if (draft.keyShaped) return;
    const nextKey = draft.key.trim();
    const nextValue = draft.mode === "unset" ? null : draft.value;
    const error =
      draftError(nextKey, existingKeys) ??
      credentialError(nextKey, nextValue, credentialRefusal);
    if (error !== null) {
      setDraft((current) => ({ ...current, error }));
      return;
    }
    if (refusedAsKey(nextKey, nextValue, props.keyRefusal)) {
      const cleared = props.keyRefusal?.(nextKey).clearsValue === true;
      setDraft((current) => ({
        ...current,
        value: cleared ? "" : current.value,
        error: null,
        keyShaped: true,
      }));
      return;
    }
    onAdd(nextKey, nextValue);
  };

  return (
    <div className="flex flex-col gap-1 border-t border-border/40 px-3 py-2">
      <div className={GRID}>
        <Input
          value={draft.key}
          disabled={disabled}
          spellCheck={false}
          placeholder={namePlaceholder}
          aria-label="New variable name"
          className="h-8"
          onChange={(event) =>
            edit((current) => ({ ...current, key: event.target.value }))
          }
          font="mono"
          size="xs"
        />
        <EnvValueField
          value={draft.value}
          mode={draft.mode}
          disabled={disabled}
          ariaLabel="New variable value"
          className={VALUE_FIELD_PLACEMENT}
          onModeChange={(mode) => edit((current) => ({ ...current, mode }))}
          onValueChange={(value) => edit((current) => ({ ...current, value }))}
          onBlur={() => undefined}
        />
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
      </div>
      <EnvRowFooter
        draft={draft}
        disabled={disabled}
        onTrim={() =>
          edit((current) => ({ ...current, value: current.value.trim() }))
        }
        keyRefusal={props.keyRefusal}
        // The value went on; nothing is stored here.
        onRefusalFollowed={onCancel}
      />
    </div>
  );
}

function EnvValueField(props: {
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
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
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
    </div>
  );
}
