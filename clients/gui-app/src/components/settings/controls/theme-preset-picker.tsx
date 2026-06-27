import { useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  THEME_PRESETS,
  findThemePreset,
  type ThemePreset,
  type ThemePresetOption,
} from "@/lib/theme-presets";

interface ThemePresetPickerProps {
  value: ThemePreset;
  onChange: (next: ThemePreset) => void;
}

/**
 * Searchable preset picker. Built on Popover + cmdk Command rather than a
 * DropdownMenu so it can live inside the modal Settings dialog: Radix Popover
 * defaults to `modal={false}`, so dismissing it does not force the dialog's
 * own layer inert and bubble a deferred outside-click up to the dialog (which
 * a modal DropdownMenu does, closing the whole Settings modal). cmdk also gives
 * us the wanted UX for free - the input autofocuses on open, and arrow keys
 * move the highlighted item via `aria-activedescendant` while DOM focus stays
 * in the input.
 *
 * The Popover panel already supplies the surface (bg + ring + radius), so the
 * Command is flattened to transparent/no-radius - otherwise it nests a second
 * rounded panel inside the first with a mismatched radius.
 *
 * When this picker lives inside the modal Settings dialog, the popover is
 * portaled INTO the dialog content rather than the default `document.body`.
 * A modal Radix dialog wraps its content in `react-remove-scroll` with the
 * dialog content as the only allowed "shard", so wheel/touch scrolling is
 * blocked everywhere else - including a body-portaled popover, leaving the
 * preset list un-scrollable by mouse. Portaling into the dialog content puts
 * the list inside that shard, and `collisionBoundary` keeps it positioned
 * within the dialog bounds. Outside a dialog (Settings opened as a tab) there
 * is no shard, so we fall back to the default body portal.
 */
export function ThemePresetPicker(props: ThemePresetPickerProps) {
  const { value, onChange } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  const active = findThemePreset(value);
  // cmdk highlights the first item by default; drive its highlighted value so
  // the active preset is the one selected on open. cmdk scrolls its selected
  // item into view, which brings presets near the end of the list into view.
  const [commandValue, setCommandValue] = useState(active.label);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setCommandValue(active.label);
          const content = triggerRef.current?.closest<HTMLElement>(
            '[data-slot="dialog-content"]',
          );
          setDialogContainer(content ?? null);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="inline-flex min-w-44 items-center justify-between gap-3 rounded-md border border-border bg-card px-2.5 py-1.5 text-ui-sm text-foreground transition-colors hover:bg-accent/50"
        >
          <span className="flex min-w-0 items-center gap-2">
            <PresetSwatch preset={active} />
            <span className="truncate">{active.label}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        container={dialogContainer ?? undefined}
        collisionBoundary={dialogContainer ?? undefined}
        collisionPadding={8}
        className="w-[min(85vw,17rem)] overflow-hidden p-0"
      >
        <Command
          value={commandValue}
          onValueChange={setCommandValue}
          className="rounded-none bg-transparent p-0"
        >
          <CommandInput
            aria-label="Search theme presets"
            placeholder="Search presets…"
            spellCheck={false}
          />
          <CommandList className="max-h-[min(50vh,18rem)] p-1">
            <CommandEmpty>No matching presets.</CommandEmpty>
            {THEME_PRESETS.map((preset) => (
              <CommandItem
                key={preset.id}
                value={preset.label}
                data-checked={preset.id === value ? "true" : "false"}
                onSelect={() => {
                  onChange(preset.id);
                  setOpen(false);
                }}
                className="gap-2.5 rounded-md py-1.5 data-selected:border-transparent data-selected:bg-accent data-selected:text-foreground data-selected:shadow-none data-[checked=true]:text-primary"
              >
                <PresetSwatch preset={preset} />
                <span className="min-w-0 flex-1 truncate">{preset.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface PresetSwatchProps {
  preset: ThemePresetOption;
}

function PresetSwatch(props: PresetSwatchProps) {
  const { preset } = props;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md font-semibold text-ui-xs ring-1 ring-foreground/10 ring-inset",
      )}
      style={{ backgroundColor: preset.swatch, color: preset.accent }}
    >
      Aa
    </span>
  );
}
