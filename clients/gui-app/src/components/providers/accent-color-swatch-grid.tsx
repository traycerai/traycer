import type { ReactNode } from "react";
import { Check } from "lucide-react";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { cn } from "@/lib/utils";

interface AccentColorSwatchGridProps {
  readonly selectedColor: ProviderProfileAccentColor | null;
  readonly disabled: boolean;
  readonly onSelectColor: (color: ProviderProfileAccentColor) => void;
}

/**
 * The full accent-color palette as a row of selectable swatches, shared by
 * the add-profile dialog's details step and the profile card's editor - both
 * rendered the identical markup independently before this extraction.
 */
export function AccentColorSwatchGrid(
  props: AccentColorSwatchGridProps,
): ReactNode {
  const { selectedColor, disabled, onSelectColor } = props;
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROVIDER_PROFILE_ACCENT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Use color ${color}`}
          aria-pressed={selectedColor === color}
          disabled={disabled}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50",
            selectedColor === color
              ? "border-foreground/40 ring-2 ring-ring/80 ring-offset-1 ring-offset-popover"
              : "",
          )}
          style={{ backgroundColor: color }}
          onClick={() => onSelectColor(color)}
        >
          {selectedColor === color ? (
            <Check className="size-3 text-black" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
