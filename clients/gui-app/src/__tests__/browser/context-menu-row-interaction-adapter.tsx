import type { ReactElement, ReactNode } from "react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * Uniform trigger/item/content shape for `context-menu-row-interaction-
 * parity.tsx`'s stand-in row content, so that fixture file can stay
 * unchanged when checked out against a HEAD (Radix) tree - only THIS
 * adapter differs per checkout. This copy targets the current (Base) API.
 * A HEAD run replaces this file's contents with
 * `scripts/fixtures/context-menu-row-interaction-adapter.HEAD.tsx.txt`
 * (same exports, Radix's `asChild`/`onSelect`/`onCloseAutoFocus`) - kept
 * outside `src/` with a `.txt` extension since this repo's tsconfig
 * `include` would otherwise pick up its Radix import on the current tree,
 * where it does not resolve.
 */
export function AdaptiveTrigger(props: {
  readonly render: ReactElement;
  readonly onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
}): ReactNode {
  return (
    <ContextMenuTrigger
      render={props.render}
      onContextMenu={props.onContextMenu}
      onPointerDown={props.onPointerDown}
    />
  );
}

export function AdaptiveContent(props: {
  readonly children: ReactNode;
  readonly finalFocus: boolean;
}): ReactNode {
  return (
    <ContextMenuContent finalFocus={props.finalFocus}>
      {props.children}
    </ContextMenuContent>
  );
}

export function AdaptiveItem(props: {
  readonly onActivate: () => void;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ContextMenuItem data-testid={props.testId} onClick={props.onActivate}>
      {props.children}
    </ContextMenuItem>
  );
}
