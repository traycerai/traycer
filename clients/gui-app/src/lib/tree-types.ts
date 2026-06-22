import type React from "react";

/**
 * Base constraint for user-provided tree node data.
 * Users extend this with their own properties.
 * Using `object` allows interfaces without index signatures.
 */
export type TreeNodeData = object;

/**
 * Nested input format - what users pass as tree data.
 */
export interface TreeNodeNested<T extends TreeNodeData = TreeNodeData> {
  /** Unique identifier for this node */
  id: string;
  /** Custom user data */
  data: T;
  /** Whether this node can have children (shows expand affordance even when empty) */
  isGroup?: boolean;
  /** Child nodes. Omit or undefined for lazy-loaded groups. */
  children?: TreeNodeNested<T>[];
}

/**
 * Internal flat representation used by the tree engine.
 */
export interface FlatTreeNode<T extends TreeNodeData = TreeNodeData> {
  id: string;
  data: T;
  isGroup: boolean;
  /** Whether children have been loaded (for lazy loading). true if children array was provided. */
  childrenLoaded: boolean;
  parentId: string | null;
  depth: number;
  /** Position among siblings (0-based) */
  index: number;
}

/**
 * Drop position relative to a target node.
 */
export type DropPosition = "before" | "after" | "inside";

/**
 * Information passed to DND event handlers.
 */
export interface TreeDragEvent<T extends TreeNodeData = TreeNodeData> {
  /** The node being dragged */
  source: FlatTreeNode<T>;
  /** The source tree instance id */
  sourceTreeId: string;
  /** The target node (drop target) */
  target: FlatTreeNode<T>;
  /** The target tree instance id */
  targetTreeId: string;
  /** Where relative to target */
  position: DropPosition;
  /** Projected depth after drop */
  projectedDepth: number;
}

/**
 * Callback for lazy loading children.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Callback for lazy loading children.
 */
export type LoadChildrenFn<T extends TreeNodeData = TreeNodeData> = (
  node: FlatTreeNode<T>,
) => Promise<TreeNodeNested<T>[]>;

/**
 * Render function props for custom node rendering.
 */
export interface TreeNodeRenderProps<T extends TreeNodeData = TreeNodeData> {
  node: FlatTreeNode<T>;
  isExpanded: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isLoading: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  dropPosition: DropPosition | null;
  depth: number;
  hasChildren: boolean;
  selectionMode: "none" | "single" | "multiple";
  toggle: () => void;
  select: (event: React.MouseEvent | undefined) => void;
}
