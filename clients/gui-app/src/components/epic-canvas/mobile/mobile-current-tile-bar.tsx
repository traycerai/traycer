import { useCallback } from "react";
import { TabIcon } from "@/components/epic-canvas/canvas/tab-strip";
import { InlineTitleField } from "@/components/epic-canvas/mobile/inline-title-field";
import { ContentMinimapButton } from "@/components/minimap/content-minimap-button";
import {
  tileRenameKind,
  useSwitcherRename,
} from "@/components/epic-canvas/mobile/use-switcher-rename";
import "@/components/layout/shell/mobile-shell-touch-targets.css";
import {
  useEpicPermissionRole,
  useEpicTabDisplayTitle,
  useEpicLiveArtifactTitleGenerating,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

interface MobileCurrentTileBarProps {
  readonly epicId: string;
  readonly tile: EpicCanvasTileRef;
}

/**
 * Slim bar under the mobile header naming the tile on screen: live icon, the
 * display title, and - for a tile whose content has an outline - the minimap
 * button at the trailing edge. Switching tabs is the header's switcher
 * trigger, so this bar carries no BETWEEN-tile navigation; the minimap moves
 * within the tile already on screen.
 *
 * The title renames in place for every kind that has a name of its own
 * (agents, artifacts, raw terminals) and an editor's permission; anything else
 * reads as plain text, matching what the switcher rows offer for the same item.
 *
 * Icon + title reuse the exact desktop tab-strip resolution (`TabIcon`,
 * `useEpicTabDisplayTitle`), including the terminal bound-host client so a
 * terminal tab shows its live host title rather than the stored name.
 */
export function MobileCurrentTileBar(props: MobileCurrentTileBarProps) {
  const { epicId, tile } = props;
  const isTerminal = tile.type === "terminal";
  // Terminal titles resolve against the tab's bound host; `null` for every
  // other kind (mirrors the tab strip). `useHostClientForHostId(null)` returns
  // the DEFAULT client, so the non-terminal branch must pass null explicitly.
  const resolvedHostClient = useHostClientForHostId(
    isTerminal ? tile.hostId : null,
  );
  const terminalHostClient = isTerminal ? resolvedHostClient : null;
  const displayTitle = useEpicTabDisplayTitle(
    {
      id: tile.id,
      name: tile.name,
      type: tile.type,
      hostId: "hostId" in tile ? tile.hostId : null,
    },
    epicId,
    terminalHostClient,
  );
  const titleGenerationPending = useEpicLiveArtifactTitleGenerating(
    tile.type === "chat" ? tile.id : null,
  );

  const renameKind = tileRenameKind(tile);
  const canMutate = isEditableRole(useEpicPermissionRole());
  const rename = useSwitcherRename(epicId);
  const handleCommit = useCallback(
    (next: string) => {
      if (renameKind === null) return;
      rename(renameKind, tile.id, next);
    },
    [rename, renameKind, tile.id],
  );

  return (
    <div
      data-mobile-shell-touch-scope=""
      className="shrink-0 border-b border-canvas-border/70 bg-canvas"
    >
      <div
        data-testid="mobile-current-tile-bar"
        className="flex min-h-11 w-full items-center gap-2 px-3"
      >
        <TabIcon
          epicId={epicId}
          tab={tile}
          titleGenerationPending={titleGenerationPending}
        />
        <InlineTitleField
          value={displayTitle}
          editable={renameKind !== null && canMutate}
          onCommit={handleCommit}
          inputLabel="Tab title"
          testId="mobile-current-tile-title"
          className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground"
        />
        <ContentMinimapButton tileInstanceId={tile.instanceId} />
      </div>
    </div>
  );
}
