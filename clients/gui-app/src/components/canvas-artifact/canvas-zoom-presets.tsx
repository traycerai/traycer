import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
export function CanvasZoomPresets({
  onZoom,
  disabled,
}: {
  readonly onZoom: (zoom: number) => void;
  readonly disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label="Zoom presets"
        >
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {[0.25, 0.5, 1, 2].map((zoom) => (
          <DropdownMenuItem key={zoom} onSelect={() => onZoom(zoom)}>
            {zoom * 100}%
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
