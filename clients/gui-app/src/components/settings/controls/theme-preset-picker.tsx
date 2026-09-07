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
import { useCoarsePointerOpenAutoFocus } from "@/hooks/ui/use-coarse-pointer-open-autofocus";
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

/** When this picker lives inside the modal Settings dialog, the popover is portaled into the dialog content
 * rather than the default `document.body`. */
export function ThemePresetPicker(props: ThemePresetPickerProps) {
  const { value, onChange } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { contentRef, onOpenAutoFocus: coarseOpenAutoFocus } =
    useCoarsePointerOpenAutoFocus();
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  const active = findThemePreset(value);
  // cmdk highlights the first item by default; drive its highlighted value so the active preset is the one
  // selected on open.
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
        ref={contentRef}
        onOpenAutoFocus={coarseOpenAutoFocus}
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
                className="gap-2.5 rounded-md py-1.5 data-[selected=true]:border-transparent data-[selected=true]:bg-accent data-[selected=true]:text-foreground data-[selected=true]:shadow-none data-[checked=true]:text-primary"
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
