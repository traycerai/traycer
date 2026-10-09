import type { CSSProperties } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import {
  SIDE_TAB_COLORLESS_TILE_CLASS,
  SIDE_TAB_MONOGRAM_CHIP_CLASS,
  SIDE_TAB_MONOGRAM_CLASS,
  SIDE_TAB_TINT_FILL_CLASS,
  type SideTabTile,
} from "./tab-identity";

/**
 * The task's 26x22 monogram chip, in the tab colour or the task's own hue:
 * the rail tile's content, and the epic panel's header (D12).
 */
export function MonogramChip(props: {
  readonly tile: SideTabTile;
  readonly tint: string | null;
  readonly tinted: boolean;
}) {
  return (
    <span
      data-testid="side-tab-monogram-chip"
      className={cn(
        SIDE_TAB_MONOGRAM_CHIP_CLASS,
        "flex shrink-0 items-center justify-center overflow-hidden",
        props.tinted ? SIDE_TAB_TINT_FILL_CLASS : SIDE_TAB_COLORLESS_TILE_CLASS,
      )}
      style={
        props.tinted && props.tint !== null
          ? ({ "--side-tab-tint": props.tint } as CSSProperties)
          : undefined
      }
    >
      <TileContent tile={props.tile} />
    </span>
  );
}

function TileContent(props: { readonly tile: SideTabTile }) {
  switch (props.tile.kind) {
    case "icon":
      return props.tile.icon;
    case "monogram":
      return (
        <span aria-hidden className={SIDE_TAB_MONOGRAM_CLASS}>
          {props.tile.text}
        </span>
      );
    case "generating":
      return (
        <AgentSpinningDots
          className="size-3.5"
          testId="side-tab-tile-generating"
          variant="dots2"
          tone="muted"
        />
      );
  }
}
