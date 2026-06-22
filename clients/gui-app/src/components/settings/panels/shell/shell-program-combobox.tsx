import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { TraycerDetectedShell } from "@traycer-clients/shared/platform/runner-host";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Editable shell picker: the field is a path input (type any absolute path →
 * Enter) with detected shells as one-click quick-picks. A configured path
 * absent from the detected list round-trips as "custom · <path>". Commits via
 * the parent's auto-save on select / Enter.
 */
export function ShellProgramCombobox(props: {
  readonly value: string;
  readonly detected: readonly TraycerDetectedShell[];
  readonly disabled: boolean;
  readonly onSave: (path: string) => void;
}) {
  const { value, detected, disabled, onSave } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const current = detected.find((shell) => shell.path === value) ?? null;
  const trimmedQuery = query.trim();
  const needle = trimmedQuery.toLowerCase();
  const filtered =
    trimmedQuery.length === 0
      ? detected
      : detected.filter(
          (shell) =>
            shell.name.toLowerCase().includes(needle) ||
            shell.path.toLowerCase().includes(needle),
        );
  const showCustom =
    trimmedQuery.length > 0 &&
    !detected.some((shell) => shell.path === trimmedQuery);

  const commit = (path: string) => {
    const next = path.trim();
    setOpen(false);
    setQuery("");
    if (next.length > 0 && next !== value) onSave(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex w-[min(60vw,22rem)] items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left text-ui-sm transition-colors hover:bg-muted/50 disabled:opacity-50"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="font-mono">
              {current === null ? basenameOf(value) : current.name}
            </span>
            <StartTruncatedText className="min-w-0 font-mono text-code-xs text-muted-foreground">
              {current === null ? `custom · ${value}` : value}
            </StartTruncatedText>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(80vw,24rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Filter or enter a custom shell path…"
            spellCheck={false}
          />
          <CommandList className="max-h-[min(50vh,13rem)]">
            {showCustom ? (
              <CommandGroup>
                <CommandItem
                  value={`custom:${trimmedQuery}`}
                  onSelect={() => commit(trimmedQuery)}
                >
                  <span className="shrink-0 font-mono">Use custom path</span>
                  <span className="shrink-0 font-mono">“</span>
                  <StartTruncatedText className="min-w-0 flex-1 font-mono">
                    {trimmedQuery}
                  </StartTruncatedText>
                  <span className="shrink-0 font-mono">”</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {filtered.length === 0 && !showCustom ? (
              <CommandEmpty>No matching shells.</CommandEmpty>
            ) : null}
            {filtered.length > 0 ? (
              <CommandGroup heading="Detected on this machine">
                {filtered.map((shell) => (
                  <CommandItem
                    key={shell.path}
                    value={shell.path}
                    data-checked={shell.path === value ? "true" : "false"}
                    onSelect={() => commit(shell.path)}
                  >
                    <span className="font-mono">{shell.name}</span>
                    <StartTruncatedText className="ml-2 min-w-0 flex-1 font-mono text-code-xs text-muted-foreground">
                      {shell.path}
                    </StartTruncatedText>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
