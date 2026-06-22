import { useCallback, useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * Renders shell flags as removable chips with an inline "+ flag" affordance.
 * Mutations are committed by the parent (auto-save) on add/remove.
 */
export function ShellFlagChips(props: {
  readonly args: readonly string[];
  readonly disabled: boolean;
  readonly onAdd: (flag: string) => void;
  readonly onRemove: (index: number) => void;
}) {
  const { args, disabled, onAdd, onRemove } = props;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  // Stable callback ref focuses the inline input when it mounts (on "+ flag")
  // without the `autoFocus` prop. Memoised so re-renders don't re-focus.
  const focusInput = useCallback((node: HTMLInputElement | null) => {
    if (node !== null) node.focus();
  }, []);

  const commit = () => {
    const trimmed = draft.trim();
    setDraft("");
    setAdding(false);
    if (trimmed.length > 0) onAdd(trimmed);
  };

  // Duplicate flags (e.g. two `-o`) get a per-occurrence key so React keeps a
  // stable identity without using the array index as the key.
  const occurrences = new Map<string, number>();
  const chips = args.map((arg, index) => {
    const occurrence = occurrences.get(arg) ?? 0;
    occurrences.set(arg, occurrence + 1);
    return { arg, index, key: `${arg}#${occurrence}` };
  });

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {args.length === 0 && !adding ? (
        <span className="text-ui-xs text-muted-foreground">No flags</span>
      ) : null}
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-code-xs"
        >
          {chip.arg}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(chip.index)}
            aria-label={`Remove flag ${chip.arg}`}
            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            ✕
          </button>
        </span>
      ))}
      {adding ? (
        <Input
          ref={focusInput}
          value={draft}
          disabled={disabled}
          placeholder="-i"
          spellCheck={false}
          aria-label="New shell flag"
          className="h-7 w-24 font-mono text-code-xs"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/60 px-2 py-1 font-mono text-code-xs text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
        >
          ＋ flag
        </button>
      )}
    </div>
  );
}
