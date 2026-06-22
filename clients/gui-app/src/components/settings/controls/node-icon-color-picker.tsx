import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  EPIC_NODE_ICONS,
  EPIC_NODE_LABELS,
  EPIC_NODE_KINDS,
  DEFAULT_EPIC_NODE_ICON_COLORS,
  type EpicNodeIconColors,
  type EpicNodeKind,
} from "@/lib/artifacts/node-display";

interface ArtifactIconColorPickerProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  colors: EpicNodeIconColors;
  onChange: (type: EpicNodeKind, color: string) => void;
  onReset: () => void;
}

export function EpicNodeIconColorPicker(props: ArtifactIconColorPickerProps) {
  const { enabled, onEnabledChange, colors, onChange, onReset } = props;
  const hasCustomColors = EPIC_NODE_KINDS.some(
    (type) => colors[type] !== DEFAULT_EPIC_NODE_ICON_COLORS[type],
  );

  return (
    <div className="flex w-80 max-w-full flex-col gap-2">
      <div className="flex items-center justify-end gap-2">
        <span className="text-ui-sm text-muted-foreground">
          Use type colors
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label="Use artifact type colors"
        />
      </div>
      {enabled ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {EPIC_NODE_KINDS.map((type) => {
              const Icon = EPIC_NODE_ICONS[type];
              const label = EPIC_NODE_LABELS[type];
              const color = colors[type];

              return (
                <label
                  key={type}
                  className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0" style={{ color }} />
                    <span className="truncate text-ui-xs text-foreground">
                      {label}
                    </span>
                  </span>
                  <input
                    type="color"
                    value={color}
                    aria-label={`${label} icon color`}
                    onChange={(event) => {
                      onChange(type, event.target.value);
                    }}
                    className="size-7 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0"
                  />
                </label>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReset}
              disabled={!hasCustomColors}
              aria-label="Reset artifact icon colors"
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
