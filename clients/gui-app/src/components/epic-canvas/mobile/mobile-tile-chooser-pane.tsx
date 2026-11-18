import { useMemo, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TileSwitcherList } from "@/components/epic-canvas/mobile/tile-switcher-list";
import type { MobileTileSlot } from "@/lib/canvas/tile-open/intent";
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

function stayOpen(): void {}

/**
 * The task's list filling a pane that has no tile to show: the second pane a
 * Split just opened, and a task with no tile on screen at all. A pick fills
 * the slot this pane stands in. The Split's pane closes from its header; the
 * empty task's has nothing to close to, so it offers no close and the pick is
 * what ends it.
 */
export function MobileTileChooserPane(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly slot: MobileTileSlot;
  /** Closes this pane without a pick; `null` where there is nothing to go back to. */
  readonly onClose: (() => void) | null;
}): ReactNode {
  const { epicId, tabId, slot, onClose } = props;
  const target = useMemo(() => ({ tabId, slot }), [slot, tabId]);
  return (
    <div
      data-mobile-shell-touch-scope=""
      data-testid="mobile-tile-chooser"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-canvas",
        slot === "secondary" && "border-l border-canvas-border/70",
      )}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-canvas-border/70 px-3">
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
          Choose a tile
        </span>
        {onClose === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close this side"
            data-testid="mobile-tile-chooser-close"
            className="shrink-0"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <nav aria-label="Choose a tile" className="flex min-h-0 flex-1 flex-col">
        <MobileTileOpenTargetContext value={target}>
          <TileSwitcherList
            epicId={epicId}
            tabId={tabId}
            onClose={onClose ?? stayOpen}
          />
        </MobileTileOpenTargetContext>
      </nav>
    </div>
  );
}
