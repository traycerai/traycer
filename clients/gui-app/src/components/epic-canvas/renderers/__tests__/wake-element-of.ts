import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

interface WakeProps {
  readonly gesture: SandboxVerbGesture | null;
  readonly hostId: string;
}

/** The element a tile mounts to wake its host when the tile is opened. */
export function wakeElementOf(
  node: EpicCanvasTileRef,
): ReactElement<WakeProps> {
  const tree: ReactNode = renderTile({
    node,
    viewTabId: "tab-1",
    tileId: "tile-1",
    epicId: "epic-1",
    isActive: true,
  });
  if (!isValidElement<{ children: ReactNode }>(tree)) {
    throw new Error("renderTile did not return an element");
  }
  for (const child of Children.toArray(tree.props.children)) {
    if (isValidElement<WakeProps>(child) && "gesture" in child.props) {
      return child;
    }
  }
  throw new Error("no wake element under the tile's host provider");
}
