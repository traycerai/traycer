import { CollabTileBody } from "./collab-tile-body";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

interface ReviewTileProps {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

export function ReviewTile(props: ReviewTileProps) {
  return (
    <CollabTileBody
      node={props.node}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
      testId="review-tile"
    />
  );
}
