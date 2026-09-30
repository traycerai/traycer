import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RAIL_BADGE_TONE, type RailBadgeKind } from "./rail-badge-kind";
import {
  SIDE_TAB_BADGE_CLASS,
  SIDE_TAB_RAIL_BADGE_CLASS,
  SIDE_TAB_RAIL_BADGE_GLYPH_CLASS,
} from "./side-strip-tokens";
import { StatusGlyph } from "@/components/notifications/status-glyph";

/**
 * The one state that needs the user, as a badge (D5). On a rail tile it is the
 * status glyph on a 14px disc of the strip's ground, so it reads as cut out of
 * the tile; on an expanded group header it is the same glyph at 10px on its
 * ringed dot.
 */
export function SideTabRailBadge(props: {
  readonly kind: RailBadgeKind;
  readonly size: "tile" | "leading";
  readonly testId: string;
}): ReactNode {
  return (
    <span
      role="img"
      aria-label={RAIL_BADGE_TONE[props.kind].title}
      data-testid={props.testId}
      data-kind={props.kind}
      className={cn(
        "flex items-center justify-center rounded-full",
        props.size === "tile"
          ? SIDE_TAB_RAIL_BADGE_CLASS
          : SIDE_TAB_BADGE_CLASS,
      )}
    >
      <StatusGlyph
        status={RAIL_BADGE_TONE[props.kind]}
        className={
          props.size === "tile" ? SIDE_TAB_RAIL_BADGE_GLYPH_CLASS : "size-2.5"
        }
        testId={undefined}
        label={null}
      />
    </span>
  );
}
