import { CustomizeDropSlot } from "@/components/customize/customize-drop-slot";
import { useComposerTileId } from "@/components/home/composer/composer-tile-hooks";
import { memo } from "react";
import { useComposerLayout } from "@/lib/layout-overrides";
import {
  renderToolbarItem,
  type ComposerToolbarItemsProps,
} from "@/components/home/toolbar/composer-toolbar-item";

function ComposerToolbarLeftImpl(props: ComposerToolbarItemsProps) {
  const tileId = useComposerTileId();
  const order = useComposerLayout().toolbar.left;

  return (
    <div className="flex min-w-0 items-center gap-1">
      {order.map((id) => (
        // `display: contents` keeps this purely structural (order + a stable
        // hook for tests) without inserting a real flex child of its own.
        <span key={id} className="contents" data-testid={`toolbar-item-${id}`}>
          {renderToolbarItem(id, props)}
        </span>
      ))}
      <CustomizeDropSlot
        id="toolbar:left"
        group="composer-toolbar"
        tileId={tileId}
        className="inline-flex size-6 shrink-0"
      />
    </div>
  );
}

export const ComposerToolbarLeft = memo(ComposerToolbarLeftImpl);
