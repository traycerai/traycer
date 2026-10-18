import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import { CanvasInlineName } from "./canvas-inline-name";
export function CanvasPages({
  pages,
  viewOnly,
  page,
  onSelect,
  onRename,
  onAdd,
  onRemove,
}: {
  readonly viewOnly?: boolean;
  readonly pages: CanvasLayoutSnapshot["pages"];
  readonly page: string;
  readonly onSelect: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b bg-background px-3 py-1">
      <div
        role="tablist"
        tabIndex={-1}
        aria-label="Canvas pages"
        className="flex min-w-0 flex-1 flex-wrap gap-1"
        onKeyDown={(event) => {
          if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
          event.preventDefault();
          const index = pages.findIndex((item) => item.id === page);
          const next =
            pages[
              (index + (event.code === "ArrowRight" ? 1 : -1) + pages.length) %
                pages.length
            ];
          if (pages.length > 0) {
            onSelect(next.id);
            const buttons =
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              );
            buttons.item(pages.indexOf(next)).focus();
          }
        }}
      >
        {pages.map((item) => (
          <Button
            key={item.id}
            role="tab"
            aria-selected={item.id === page}
            tabIndex={item.id === page ? 0 : -1}
            variant={item.id === page ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onSelect(item.id)}
          >
            {item.name}
          </Button>
        ))}
      </div>
      {viewOnly ? null : (
        <>
          {pages.find((item) => item.id === page) ? (
            <CanvasInlineName
              value={pages.find((item) => item.id === page)?.name ?? "Page"}
              label="Rename page"
              onCommit={(name) => onRename(page, name)}
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add page"
            onClick={onAdd}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove page"
            disabled={pages.length <= 1}
            onClick={() => onRemove(page)}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </div>
  );
}
