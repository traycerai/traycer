import { Copy, Ellipsis, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";

export function CanvasElementMenu({
  disabled,
  onEdit,
}: {
  readonly disabled: boolean;
  readonly onEdit: (edit: ArtboardEdit) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Element actions"
          disabled={disabled}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => onEdit({ kind: "duplicate-element" })}
        >
          <Copy />
          Duplicate element
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onEdit({ kind: "delete-element" })}
        >
          <Trash2 />
          Delete element
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
