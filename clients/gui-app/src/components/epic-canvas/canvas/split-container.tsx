/**
 * Generic, content-agnostic split-container renderer for the N-ary tile
 * tree (see `stores/epics/canvas/tile-tree.ts`).
 *
 * The engine knows NOTHING about tile kinds: panes render through the
 * injected `renderPane`, so the layout layer can be tested in isolation and
 * reused for any pane content. Groups render as plain nested flex
 * containers - each child wrapper gets `flexGrow: fraction` - and resizing
 * is handled by `SplitResizeHandle` via direct DOM mutation (zero React
 * renders during a drag, one store commit on release).
 *
 * Identity rules that prevent remounts:
 * - every child is keyed by its node id (stable across reorder/resize),
 * - groups never store sizes (a resize commit changes only
 *   `sizesByGroupId`, so `root` and every node in it keep identity),
 * - `SplitNodeView` is memoized, so a structural change re-renders only the
 *   path from the root to the touched node (untouched siblings bail out on
 *   identity-equal props).
 */
import { Fragment, memo, type ComponentType } from "react";
import type {
  SizesByGroupId,
  TileLayoutNode,
  TilePane,
} from "@/stores/epics/canvas/tile-tree";
import { sizesForGroup } from "@/stores/epics/canvas/tile-tree";
import { MIN_PANE_PX } from "@/stores/epics/canvas/tile-tree-constants";
import { SplitResizeHandle } from "./resize-handle";
import { cn } from "@/lib/utils";

export interface SplitContainerProps {
  readonly root: TileLayoutNode | null;
  readonly sizesByGroupId: SizesByGroupId;
  readonly PaneComponent: ComponentType<SplitPaneComponentProps>;
  readonly onResizeGroup: (
    groupId: string,
    sizes: ReadonlyArray<number>,
  ) => void;
}

export interface SplitPaneComponentProps {
  readonly pane: TilePane;
}

export function SplitContainer(props: SplitContainerProps) {
  if (props.root === null) return null;
  return (
    <SplitNodeView
      node={props.root}
      sizesByGroupId={props.sizesByGroupId}
      PaneComponent={props.PaneComponent}
      onResizeGroup={props.onResizeGroup}
    />
  );
}

interface SplitNodeViewProps {
  readonly node: TileLayoutNode;
  readonly sizesByGroupId: SizesByGroupId;
  readonly PaneComponent: ComponentType<SplitPaneComponentProps>;
  readonly onResizeGroup: (
    groupId: string,
    sizes: ReadonlyArray<number>,
  ) => void;
}

const SplitNodeView = memo(function SplitNodeView(props: SplitNodeViewProps) {
  const { node, sizesByGroupId, PaneComponent, onResizeGroup } = props;
  if (node.kind === "pane") {
    return <PaneComponent pane={node} />;
  }

  const sizes = sizesForGroup(sizesByGroupId, node);
  const horizontal = node.direction === "horizontal";
  return (
    <div
      data-testid="tile-split"
      data-split-id={node.id}
      data-axis={node.direction}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0",
        horizontal ? "flex-row" : "flex-col",
      )}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 ? (
            <SplitResizeHandle
              groupId={node.id}
              index={index - 1}
              direction={node.direction}
              sizes={sizes}
              minChildPx={MIN_PANE_PX}
              className={undefined}
              onCommitSizes={onResizeGroup}
            />
          ) : null}
          <div
            data-split-child
            className="relative min-h-0 min-w-0"
            style={{ flexGrow: sizes[index], flexBasis: 0, flexShrink: 1 }}
          >
            <SplitNodeView
              node={child}
              sizesByGroupId={sizesByGroupId}
              PaneComponent={PaneComponent}
              onResizeGroup={onResizeGroup}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
});
