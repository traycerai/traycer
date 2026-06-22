import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

export function ThemePresetPicker(props: ThemePresetPickerProps) {
  const { value, onChange } = props;
  const active = findThemePreset(value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-44 items-center justify-between gap-3 rounded-md border border-border bg-card px-2.5 py-1.5 text-ui-sm text-foreground transition-colors hover:bg-accent/50"
        >
          <span className="flex items-center gap-2">
            <PresetSwatch preset={active} />
            {active.label}
          </span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 min-w-52 overflow-y-auto"
      >
        {THEME_PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onSelect={() => {
              onChange(preset.id);
            }}
            className="gap-2"
          >
            <PresetSwatch preset={preset} />
            <span className="flex-1 truncate">{preset.label}</span>
            {preset.id === value ? (
              <span className="text-ui-xs text-muted-foreground">✓</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 font-semibold text-ui-xs",
      )}
      style={{ backgroundColor: preset.swatch, color: preset.accent }}
    >
      Aa
    </span>
  );
}
