import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Its own mark rather than an `EpicNodeKind` icon: the tile is not an epic node, so it has no entry in the per-kind icon-color registry and must not borrow one.
 */
export function CommGraphTileIcon(props: { readonly className: string }) {
  return (
    <Building2
      className={cn("shrink-0 text-muted-foreground", props.className)}
    />
  );
}
