import { CollabTileBody } from "./collab-tile-body";
import { ArtifactVersionHistoryEntryPoint } from "./artifact-version-history";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

interface SpecTileProps {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

export function SpecTile(props: SpecTileProps) {
  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <CollabTileBody
          node={props.node}
          viewTabId={props.viewTabId}
          tileId={props.tileId}
          isActive={props.isActive}
          testId="spec-tile"
        />
      </div>
      <ArtifactVersionHistoryEntryPoint artifactId={props.node.id} />
    </div>
  );
}
