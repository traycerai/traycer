import { CollabTileBody } from "./collab-tile-body";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

interface SpecTileProps {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

export function SpecTile(props: SpecTileProps) {
  return (
    <CollabTileBody
      node={props.node}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
      testId="spec-tile"
    />
  );
}
