import { RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

interface NullableFontSizeInputProps {
  readonly value: number | null;
  /** Value shown (and live-tracked) while `value` is null. */
  readonly followValue: number;
  readonly onChange: (next: number | null) => void;
  readonly min: number;
  readonly max: number;
  readonly ariaLabel: string;
  readonly resetTooltip: string;
}

/**
 * `SettingsNumberInput`-style number field that additionally supports a
 * `null` "follow" state: the displayed value tracks `followValue` in muted
 * styling until the user ticks or types, which pins an explicit value
 * starting from what was displayed. A ghost reset button clears back to
 * `null`. Kept separate from `SettingsNumberInput` (non-nullable) so its two
 * existing call sites are untouched.
 */
export function NullableFontSizeInput(props: NullableFontSizeInputProps) {
  const { value, followValue, onChange, min, max, ariaLabel, resetTooltip } =
    props;
  const isFollowing = value === null;
  const displayed = value ?? followValue;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex size-7 shrink-0 items-center justify-center">
        {!isFollowing ? (
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
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={displayed}
          min={min}
          max={max}
          step={1}
          aria-label={ariaLabel}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) return;
            onChange(parsed);
          }}
          className={cn(
            "h-8 w-20 text-right",
            isFollowing && "text-muted-foreground",
          )}
        />
        <span className="text-ui-sm text-muted-foreground">px</span>
      </div>
    </div>
  );
}
