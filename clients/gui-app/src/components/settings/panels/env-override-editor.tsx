import { useEffect, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

/**
 * Shared inline environment-override editor (Settings → Providers per-provider,
 * and Settings → Shell host-process). One flat, column-aligned table:
 * `Name · Set/Unset value · actions`, with an explicit staged add row. `value:
 * null` is an explicit unset (drop a variable the process would otherwise
 * inherit). The parent owns the mutations.
 */

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Single grid shared by the header, every row, and the add row so the column
// edges line up exactly (the previous header/rows used different padding). The
// last track is fixed so the row delete button and the add button never shift
// the Name/Value boundaries.
const GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_4.75rem] items-center gap-2";

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
}

function modeForValue(value: string | null): EnvMode {
  return value === null ? "unset" : "set";
}

function isEnvMode(value: string): value is EnvMode {
  return value === "set" || value === "unset";
}

function draftError(key: string, otherKeys: readonly string[]): string | null {
  if (!ENV_KEY_PATTERN.test(key)) {
    return "Name must match /^[A-Za-z_][A-Za-z0-9_]*$/.";
  }
  if (otherKeys.includes(key)) return `${key} already exists.`;
  return null;
}

export function EnvOverrideEditor(props: {
  readonly overrides: readonly EnvOverrideValue[];
  readonly disabled: boolean;
  readonly namePlaceholder: string;
  readonly emptyLabel: string;
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void;
  readonly onDelete: (key: string) => void;
}) {
  const {
    overrides,
    disabled,
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
          "border-b border-border/40 bg-muted/30 px-3 py-2 text-ui-xs font-medium text-muted-foreground",
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
          {overrides.map((entry) => (
            <EnvOverrideRow
              key={entry.key}
              entry={entry}
              otherKeys={keys.filter((k) => k !== entry.key)}
              disabled={disabled}
              onCommit={onCommit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      ) : null}
      {adding ? (
        <EnvOverrideAddRow
          existingKeys={keys}
          disabled={disabled}
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
            Add environment variable
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
  readonly onCommit: (
    oldKey: string,
    newKey: string,
    value: string | null,
  ) => void;
  readonly onDelete: (key: string) => void;
}) {
  const { entry, otherKeys, disabled, onCommit, onDelete } = props;
  const [draft, setDraft] = useState<Draft>(() => ({
    key: entry.key,
    value: entry.value ?? "",
    mode: modeForValue(entry.value),
    error: null,
  }));
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

  const commit = (): void => {
    const nextKey = draft.key.trim();
    const nextValue = draft.mode === "unset" ? null : draft.value;
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

  useEffect(() => {
    return () => {
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

  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className={GRID}>
        <Input
          value={draft.key}
          disabled={disabled}
          spellCheck={false}
          aria-label={`Name for ${entry.key}`}
          className="h-8 font-mono text-code-xs"
          onChange={(event) =>
            setDraft((current) => ({ ...current, key: event.target.value }))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={commit}
        />
        <EnvValueField
          value={draft.value}
          mode={draft.mode}
          disabled={disabled}
          ariaLabel={`Value for ${entry.key}`}
          onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, value }))
          }
          onBlur={commit}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDelete(entry.key)}
          aria-label={`Remove ${entry.key}`}
          className="flex size-8 items-center justify-center justify-self-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive disabled:opacity-50"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {draft.error !== null ? (
        <p className="text-ui-xs text-destructive">{draft.error}</p>
      ) : null}
    </li>
  );
}

function EnvOverrideAddRow(props: {
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
    const error = draftError(nextKey, existingKeys);
    if (error !== null) {
      setDraft((current) => ({ ...current, error }));
      return;
    }
    onAdd(nextKey, draft.mode === "unset" ? null : draft.value);
  };

  return (
    <div className="flex flex-col gap-1 border-t border-border/40 px-3 py-2">
      <div className={GRID}>
        <Input
          value={draft.key}
          disabled={disabled}
          spellCheck={false}
          placeholder={namePlaceholder}
          aria-label="New environment variable name"
          className="h-8 font-mono text-code-xs"
          onChange={(event) =>
            setDraft((current) => ({ ...current, key: event.target.value }))
          }
        />
        <EnvValueField
          value={draft.value}
          mode={draft.mode}
          disabled={disabled}
          ariaLabel="New environment variable value"
          onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, value }))
          }
          onBlur={() => undefined}
        />
        <div className="flex justify-self-center">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={disabled || draft.key.trim().length === 0}
            aria-label="Apply environment variable"
            onClick={add}
          >
            <Check className="size-4 text-[var(--term-ansi-green)]" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={disabled}
            aria-label="Discard environment variable"
            onClick={onCancel}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {draft.error !== null ? (
        <p className="text-ui-xs text-destructive">{draft.error}</p>
      ) : null}
    </div>
  );
}

function EnvValueField(props: {
  readonly value: string;
  readonly mode: EnvMode;
  readonly disabled: boolean;
  readonly ariaLabel: string;
  readonly onModeChange: (mode: EnvMode) => void;
  readonly onValueChange: (value: string) => void;
  readonly onBlur: () => void;
}) {
  const {
    value,
    mode,
    disabled,
    ariaLabel,
    onModeChange,
    onValueChange,
    onBlur,
  } = props;
  return (
    <div className="flex min-w-0 items-center gap-2">
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
        placeholder={mode === "unset" ? "removed from environment" : "value"}
        className="h-8 min-w-0 flex-1 font-mono text-code-xs"
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={onBlur}
      />
    </div>
  );
}
