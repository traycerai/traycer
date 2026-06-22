import { Input } from "@/components/ui/input";
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
  } = props;

  return (
    <div className={cn("flex items-center gap-2", className)}>
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
  );
}
