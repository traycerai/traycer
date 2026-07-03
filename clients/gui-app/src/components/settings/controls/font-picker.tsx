import { useRef, useState } from "react";
import { ChevronsUpDown, RotateCcw } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { quoteFontFamily } from "@/lib/default-font-stacks";
import type { InstalledFont } from "@/lib/desktop-installed-fonts";

interface FontPickerProps {
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
  readonly options: readonly InstalledFont[];
  readonly defaultLabel: string;
  readonly resetTooltip: string;
  readonly ariaLabel: string;
}

/**
 * Searchable font picker modeled on `ThemePresetPicker` (Popover + cmdk
 * combobox, portaled into the enclosing Settings dialog so its scroll shard
 * still works). The first entry is always the group's default ("Figtree
 * (Default)" / "System Default" / "Same as code font"), which stores `null`.
 * Typing a name absent from `options` offers a "Use <typed>" item so an
 * unlisted or misdetected font - and non-desktop hosts, which have no
 * enumerated list at all - still works.
 */
export function FontPicker(props: FontPickerProps) {
  const { value, onChange, options, defaultLabel, resetTooltip, ariaLabel } =
    props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );

  const trimmedQuery = query.trim();
  const needle = trimmedQuery.toLowerCase();
  const filtered =
    trimmedQuery.length === 0
      ? options
      : options.filter((font) => font.family.toLowerCase().includes(needle));
  const showCustom =
    trimmedQuery.length > 0 &&
    !options.some((font) => font.family.toLowerCase() === needle);

  const commit = (next: string | null) => {
    setOpen(false);
    setQuery("");
    onChange(next);
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex size-7 shrink-0 items-center justify-center">
        {value !== null ? (
          <TooltipWrapper
            label={resetTooltip}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={resetTooltip}
              onClick={() => onChange(null)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipWrapper>
        ) : null}
      </div>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            const content = triggerRef.current?.closest<HTMLElement>(
              '[data-slot="dialog-content"]',
            );
            setDialogContainer(content ?? null);
          } else {
            setQuery("");
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={ariaLabel}
            className="inline-flex min-w-44 items-center justify-between gap-3 rounded-md border border-border bg-card px-2.5 py-1.5 text-ui-sm text-foreground transition-colors hover:bg-accent/50"
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left",
                value === null && "text-muted-foreground",
              )}
              style={
                value !== null
                  ? { fontFamily: quoteFontFamily(value) }
                  : undefined
              }
            >
              {value ?? defaultLabel}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          container={dialogContainer ?? undefined}
          collisionBoundary={dialogContainer ?? undefined}
          collisionPadding={8}
          className="w-[min(85vw,18rem)] overflow-hidden p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              aria-label={`Search ${ariaLabel.toLowerCase()}`}
              value={query}
              onValueChange={setQuery}
              placeholder="Search fonts…"
              spellCheck={false}
            />
            <CommandList className="max-h-[min(50vh,18rem)] p-1">
              <CommandGroup>
                <CommandItem
                  value="__default__"
                  data-checked={value === null ? "true" : "false"}
                  onSelect={() => commit(null)}
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {defaultLabel}
                  </span>
                </CommandItem>
              </CommandGroup>
              {showCustom ? (
                <CommandGroup>
                  <CommandItem
                    value={`custom:${trimmedQuery}`}
                    onSelect={() => commit(trimmedQuery)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {`Use "${trimmedQuery}"`}
                    </span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {filtered.length === 0 && !showCustom ? (
                <CommandEmpty>No matching fonts.</CommandEmpty>
              ) : null}
              {filtered.length > 0 ? (
                <CommandGroup heading="Installed fonts">
                  {filtered.map((font) => (
                    <CommandItem
                      key={font.family}
                      value={font.family}
                      data-checked={font.family === value ? "true" : "false"}
                      onSelect={() => commit(font.family)}
                    >
                      <span
                        className="min-w-0 flex-1 truncate"
                        style={{ fontFamily: quoteFontFamily(font.family) }}
                      >
                        {font.family}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
