import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Ellipsis,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import { boardName, type CanvasPageItems } from "./canvas-model";

/**
 * Pages and the current page's reading order share one dropdown, so the canvas
 * keeps a single toolbar row under the tile's own tab strip.
 */
export function CanvasPageMenu({
  pages,
  viewOnly,
  page,
  boards,
  onSelect,
  onRename,
  onAdd,
  onRemove,
  onCenterBoard,
  onMoveBoard,
}: {
  readonly viewOnly: boolean;
  readonly pages: CanvasLayoutSnapshot["pages"];
  readonly page: string;
  readonly boards: CanvasPageItems["boards"];
  readonly onSelect: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (id: string) => void;
  readonly onCenterBoard: (path: string) => void;
  readonly onMoveBoard: (path: string, before: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = pages.find((item) => item.id === page);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Pages">
          <span className="max-w-40 truncate">{current?.name ?? "Page"}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <ul aria-label="Canvas pages" className="flex flex-col">
          {pages.map((item) => (
            <li key={item.id}>
              <div className="group flex items-center gap-1 rounded-md hover:bg-foreground/5">
                {renaming === item.id ? (
                  <PageNameInput
                    value={item.name}
                    onDone={(name) => {
                      if (name !== null) onRename(item.id, name);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-current={item.id === page ? "page" : undefined}
                    onClick={() => {
                      onSelect(item.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(item.id === page ? "visible" : "invisible")}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {item.name}
                    </span>
                  </Button>
                )}
                {viewOnly || renaming === item.id ? null : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Actions for ${item.name}`}
                      >
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(item.id)}>
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={pages.length <= 1}
                        variant="destructive"
                        onSelect={() => onRemove(item.id)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {item.id === page && boards.length > 0 ? (
                <ReadingOrder
                  boards={boards}
                  viewOnly={viewOnly}
                  onCenter={(path) => {
                    onCenterBoard(path);
                    setOpen(false);
                  }}
                  onMove={onMoveBoard}
                />
              ) : null}
            </li>
          ))}
        </ul>
        {viewOnly ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              onAdd();
              setOpen(false);
            }}
          >
            <Plus />
            <span className="min-w-0 flex-1 text-left">New page</span>
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function PageNameInput({
  value,
  onDone,
}: {
  readonly value: string;
  readonly onDone: (name: string | null) => void;
}) {
  const cancelled = useRef(false);
  return (
    <Input
      className="touch-auto"
      aria-label="Page name"
      size="xs"
      defaultValue={value}
      ref={(node) => node?.focus()}
      onBlur={(event) => {
        const name = event.currentTarget.value.trim();
        onDone(
          !cancelled.current && name.length > 0 && name !== value ? name : null,
        );
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.code === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        }
        if (event.code === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/** The boards of the current page in reading order: click jumps, drag reorders. */
function ReadingOrder({
  boards,
  viewOnly,
  onCenter,
  onMove,
}: {
  readonly boards: CanvasPageItems["boards"];
  readonly viewOnly: boolean;
  readonly onCenter: (path: string) => void;
  readonly onMove: (path: string, before: string | null) => void;
}) {
  const dragged = useRef<string | null>(null);
  return (
    <ol aria-label="Board reading order" className="mb-1 ml-6 flex flex-col">
      {boards.map(([path, board], index) => (
        <li
          key={path}
          draggable={!viewOnly}
          onDragStart={(event) => {
            if (viewOnly) return;
            event.dataTransfer.setData("text/plain", path);
            dragged.current = path;
          }}
          onDragEnd={() => {
            dragged.current = null;
          }}
          onDragOver={(event) => {
            if (dragged.current !== null) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (!viewOnly && dragged.current !== null)
              onMove(dragged.current, path);
            dragged.current = null;
          }}
          className="group flex items-center gap-0.5 rounded-md hover:bg-foreground/5"
        >
          <Button
            variant="ghost"
            size="xs"
            className="min-w-0 flex-1"
            onClick={() => onCenter(path)}
          >
            <span className="w-4 shrink-0 text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-left">
              {board.title || boardName(path)}
            </span>
          </Button>
          {viewOnly ? null : (
            <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={index === 0}
                aria-label={`Move ${board.title || boardName(path)} earlier`}
                onClick={() => onMove(path, boards[index - 1][0])}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={index === boards.length - 1}
                aria-label={`Move ${board.title || boardName(path)} later`}
                onClick={() => onMove(path, boards[index + 2]?.[0] ?? null)}
              >
                <ArrowDown />
              </Button>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
