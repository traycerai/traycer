import { createContext, use } from "react";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";

/** The edge of the nearest vertical column; null outside a column. */
export const ColumnEdgeContext = createContext<EdgeSide | null>(null);

export function useColumnOverlayPlacement(anchor: "top" | "row" | "foot"): {
  readonly side: EdgeSide;
  readonly align: "start" | "end";
} | null {
  const edge = use(ColumnEdgeContext);
  if (edge === null) return null;
  return {
    side: edge === "left" ? "right" : "left",
    align: anchor === "foot" ? "end" : "start",
  };
}
