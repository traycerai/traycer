import { useLayoutEffect, useRef, useState } from "react";
import { Grip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { CustomizeSearch } from "@/components/customize/customize-search";
import { exitCustomize } from "@/lib/customize/enter-exit";
import {
  ALL_LAYOUT_SLICES,
  recordSettingGesture,
  redo,
  undo,
} from "@/lib/customize/history";
import {
  applyLayoutPreset,
  LAYOUT_PRESET_IDS,
  LAYOUT_PRESET_LABELS,
  resetLayoutToDefaults,
  useLayoutIsFullyDefault,
  useLayoutPresetMatch,
} from "@/lib/layout-presets";
import { useCustomizeStore } from "@/stores/customize/customize-store";

interface Position {
  readonly x: number;
  readonly y: number;
}
export function CustomizeBar({
  unreachable,
}: {
  unreachable: ReadonlySet<string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    start: Position;
  } | null>(null);
  const moved = useRef(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const padding = useSafeAreaCollisionPadding();
  const editing = useCustomizeStore((state) => state.session !== null);
  const history = useCustomizeStore((state) => state.history);
  const announcement = useCustomizeStore((state) => state.announcement);
  const match = useLayoutPresetMatch();
  const fullyDefault = useLayoutIsFullyDefault(match);
  const clamp = (value: Position): Position => {
    const bounds = ref.current?.getBoundingClientRect();
    return {
      x: Math.max(
        padding.left,
        Math.min(
          value.x,
          window.innerWidth - padding.right - (bounds?.width ?? 0),
        ),
      ),
      y: Math.max(
        padding.top,
        Math.min(
          value.y,
          window.innerHeight - padding.bottom - (bounds?.height ?? 0),
        ),
      ),
    };
  };
  useLayoutEffect(() => {
    const resized = () =>
      setPosition((current) => {
        if (!current) return current;
        const bounds = ref.current?.getBoundingClientRect();
        return {
          x: Math.max(
            padding.left,
            Math.min(
              current.x,
              window.innerWidth - padding.right - (bounds?.width ?? 0),
            ),
          ),
          y: Math.max(
            padding.top,
            Math.min(
              current.y,
              window.innerHeight - padding.bottom - (bounds?.height ?? 0),
            ),
          ),
        };
      });
    const observer = new ResizeObserver(resized);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", resized);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resized);
    };
  }, [padding]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Customize layout"
      data-state={editing ? "open" : "closed"}
      data-customize-bar
      className="pointer-events-auto fixed top-safe-top-gutter left-safe-center-x flex w-max max-w-safe-dvw -translate-x-1/2 flex-wrap items-center gap-4 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
      style={
        position
          ? {
              left: position.x,
              top: position.y,
              transform: "none",
              maxWidth: window.innerWidth - padding.left - padding.right,
            }
          : undefined
      }
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Move Customize bar"
            className="touch-none [-webkit-app-region:no-drag]"
            onPointerDown={(event) => {
              if (event.button !== 0 || drag.current) return;
              // Radix opens on pointerdown. The handle instead opens on click so a
              // captured pointer remains free to drag, with keyboard click intact.
              event.preventDefault();
              const rect = ref.current?.getBoundingClientRect();
              if (!rect) return;
              moved.current = false;
              drag.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                start: { x: rect.x, y: rect.y },
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              const dx = event.clientX - current.x,
                dy = event.clientY - current.y;
              if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
              if (moved.current)
                setPosition(
                  clamp({ x: current.start.x + dx, y: current.start.y + dy }),
                );
            }}
            onPointerUp={(event) => {
              if (drag.current?.pointerId === event.pointerId) {
                drag.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onClick={(event) => {
              if (moved.current) {
                event.preventDefault();
                moved.current = false;
              } else setMenuOpen((open) => !open);
            }}
          >
            <Grip />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-customize-editor>
          {(
            ["Top left", "Top right", "Bottom left", "Bottom right"] as const
          ).map((corner) => (
            <DropdownMenuItem
              key={corner}
              onSelect={() =>
                setPosition(
                  clamp({
                    x: corner.endsWith("right")
                      ? window.innerWidth
                      : padding.left,
                    y: corner.startsWith("Bottom")
                      ? window.innerHeight
                      : padding.top,
                  }),
                )
              }
            >
              Move to {corner.toLowerCase()}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setPosition(null)}>
            Reset bar position
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CustomizeSearch unreachable={unreachable} />
      <div className="flex flex-wrap items-center gap-2">
        <RadioGroup
          className="flex flex-wrap"
          aria-label="Layout preset"
          value={match}
          onValueChange={(value) => {
            const preset = LAYOUT_PRESET_IDS.find((id) => id === value);
            if (preset)
              recordSettingGesture(
                `layout.preset.${preset}`,
                `${LAYOUT_PRESET_LABELS[preset]} preset`,
                ALL_LAYOUT_SLICES,
                () => applyLayoutPreset(preset),
              );
          }}
        >
          {LAYOUT_PRESET_IDS.map((preset) => (
            <label key={preset} className="flex items-center gap-1 text-ui-sm">
              <RadioGroupItem value={preset} />
              {LAYOUT_PRESET_LABELS[preset]}
            </label>
          ))}
        </RadioGroup>
        {match === "custom" ? <Badge variant="muted">Custom</Badge> : null}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={!history.past.length}
          aria-label={`Undo: ${history.past.at(-1)?.label ?? "no changes"}`}
          onClick={undo}
        >
          Undo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!history.future.length}
          aria-label={`Redo: ${history.future.at(-1)?.label ?? "no changes"}`}
          onClick={redo}
        >
          Redo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={fullyDefault}
          onClick={() =>
            recordSettingGesture(
              "layout.preset.default",
              "Reset layout",
              ALL_LAYOUT_SLICES,
              resetLayoutToDefaults,
            )
          }
        >
          Reset
        </Button>
      </div>
      <Button size="sm" onClick={() => exitCustomize("done")}>
        Done
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
