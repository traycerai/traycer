import { RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

interface SettingsNumberInputProps {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  className?: string;
  ariaLabel: string;
  /** Value the ghost reset button restores; the button hides while `value` already equals it. */
  defaultValue: number;
  resetTooltip: string;
}

export function SettingsNumberInput(props: SettingsNumberInputProps) {
  const {
    value,
    onChange,
    min,
    max,
    step = 1,
    unit,
    className,
    ariaLabel,
    defaultValue,
    resetTooltip,
  } = props;

  const isDefault = value === defaultValue;

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div className="flex size-7 shrink-0 items-center justify-center">
        {!isDefault ? (
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
              onClick={() => onChange(defaultValue)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipWrapper>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          aria-label={ariaLabel}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) return;
            onChange(parsed);
          }}
          className="h-8 w-20 text-right"
        />
        {unit ? (
          <span className="text-ui-sm text-muted-foreground">{unit}</span>
        ) : null}
      </div>
    </div>
  );
}
