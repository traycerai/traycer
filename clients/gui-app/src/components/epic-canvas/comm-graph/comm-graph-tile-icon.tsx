import { NetworkIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tab-strip / drag-chip glyph for the comm-graph tile. Its own mark rather than
 * an `EpicNodeKind` icon: the tile is not an epic node, so it has no entry in
 * the per-kind icon-color registry and must not borrow one.
 */
export function CommGraphTileIcon(props: { readonly className: string }) {
  return (
    <NetworkIcon
      className={cn("shrink-0 text-muted-foreground", props.className)}
    />
  );
}
