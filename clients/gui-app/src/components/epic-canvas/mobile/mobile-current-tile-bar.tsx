import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabIcon } from "@/components/epic-canvas/canvas/tab-strip";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import {
  useEpicTabDisplayTitle,
  useEpicLiveArtifactTitleGenerating,
} from "@/lib/epic-selectors";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

interface MobileCurrentTileBarProps {
  readonly epicId: string;
  readonly tile: EpicCanvasTileRef;
  readonly onOpenSwitcher: () => void;
}

/**
 * Slim bar under the mobile header showing the current tile (live icon +
 * display title) with a chevron. Tapping it opens the "Switch tab" bottom
 * sheet - Phase 2 owns the sheet; Phase 1 wires the affordance to
 * `onOpenSwitcher`.
 *
 * Icon + title reuse the exact desktop tab-strip resolution (`TabIcon`,
 * `useEpicTabDisplayTitle`), including the terminal bound-host client so a
 * terminal tab shows its live host title rather than the stored name.
 */
export function MobileCurrentTileBar(props: MobileCurrentTileBarProps) {
  const { epicId, tile, onOpenSwitcher } = props;
  const isTerminal = tile.type === "terminal";
  // Terminal titles resolve against the tab's bound host; `null` for every
  // other kind (mirrors the tab strip). `useHostClientForHostId(null)` returns
  // the DEFAULT client, so the non-terminal branch must pass null explicitly.
  const resolvedHostClient = useHostClientForHostId(
    isTerminal ? tile.hostId : null,
  );
  const terminalHostClient = isTerminal ? resolvedHostClient : null;
  const displayTitle = useEpicTabDisplayTitle(
    { id: tile.id, name: tile.name, type: tile.type },
    epicId,
    terminalHostClient,
  );
  const titleGenerationPending = useEpicLiveArtifactTitleGenerating(
    tile.type === "chat" ? tile.id : null,
  );

  return (
    <div
      data-mobile-shell-touch-scope=""
      className="shrink-0 border-b border-canvas-border/70 bg-canvas"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={onOpenSwitcher}
        data-testid="mobile-current-tile-bar"
        aria-label={`Switch tab. Current tab: ${displayTitle}`}
        className="flex min-h-11 w-full items-center justify-start gap-2 rounded-none px-3 text-left"
      >
        <TabIcon
          epicId={epicId}
          tab={tile}
          titleGenerationPending={titleGenerationPending}
        />
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
          {displayTitle}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </Button>
    </div>
  );
}
