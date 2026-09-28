import { memo } from "react";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/region-drag";
import { LayoutClusterContextMenu } from "@/components/layout-editor/region-quick-verbs";
import { useArrangementValue } from "@/lib/layout-overrides";
import {
  renderToolbarItem,
  type ComposerToolbarItemsProps,
} from "@/components/home/toolbar/composer-toolbar-item";

function ComposerToolbarLeftImpl(props: ComposerToolbarItemsProps) {
  const order = useArrangementValue("toolbarLeft");
  const cluster = (
    // The box this cluster's items are laid out in, which is the scope a
    // canvas drag reorders inside (G3-01).
    <div
      {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}
      className="flex min-w-0 items-center gap-1"
    >
      {order.map((id) => (
        // `display: contents` keeps this purely structural (order + a stable
        // hook for tests) without inserting a real flex child of its own.
        <span key={id} className="contents" data-testid={`toolbar-item-${id}`}>
          {renderToolbarItem(id, props)}
        </span>
      ))}
    </div>
  );

  // One menu for the strip, naming whichever item the pointer was over
  // (G3-10) - including the presentation copy, which is the sample workspace's
  // toolbar and therefore the one the user right-clicks while customizing
  // (L-129). What `presentation` still turns off is the item's own behaviour
  // (`registerActivation`), not the menu: a quick verb writes the same value
  // the inspector's control writes, so it is exactly as true here as on the
  // real composer.
  return <LayoutClusterContextMenu>{cluster}</LayoutClusterContextMenu>;
}

export const ComposerToolbarLeft = memo(ComposerToolbarLeftImpl);
