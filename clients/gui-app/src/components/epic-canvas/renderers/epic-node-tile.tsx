import type { ReactNode } from "react";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { renderTile, type TileRenderArgs } from "./tile-render";

export type EpicNodeTileProps = TileRenderArgs<EpicCanvasTileRef>;

export function EpicNodeTile(props: EpicNodeTileProps): ReactNode {
  return renderTile(props);
}
