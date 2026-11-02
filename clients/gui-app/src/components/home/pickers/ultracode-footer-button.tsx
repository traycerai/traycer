import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface UltracodeFooterConfig {
  readonly requested: boolean;
  readonly carried: boolean;
  readonly offered: boolean | undefined;
  readonly modelLabel: string;
  readonly onChange: (next: boolean) => void;
}

export function UltracodeFooterButton(props: UltracodeFooterConfig) {
  const id = useId();
  const disabled = !props.carried || props.offered !== true;
  return (
    <div
      data-testid="picker-ultracode-row"
      data-picker-ultracode=""
      className={cn(
        "flex shrink-0 items-center gap-2 border-t px-3 py-2",
        disabled && "opacity-50",
      )}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor={id}>Ultracode</Label>
        <p
          id={`${id}-hint`}
          className="truncate text-ui-xs whitespace-nowrap text-muted-foreground"
        >
          {props.offered === false
            ? `Not offered for ${props.modelLabel}`
            : "Multi-agent · uses more of your limits"}
        </p>
      </div>
      <Switch
        id={id}
        checked={props.requested}
        disabled={disabled}
        onCheckedChange={props.onChange}
        aria-describedby={`${id}-hint`}
      />
    </div>
  );
}
