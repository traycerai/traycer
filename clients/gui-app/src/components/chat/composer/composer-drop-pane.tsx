import type { ComponentProps, ReactNode } from "react";

import { useComposerDropScope } from "@/components/chat/composer/composer-drop-scope";

/**
 * A pane element that is the drop zone for the box inside it. The element
 * must be positioned: the overlay fills it.
 */
export function ComposerDropPane(props: ComponentProps<"div">): ReactNode {
  const { children, ...pane } = props;
  const scope = useComposerDropScope();
  return (
    <div {...pane} {...scope.zoneProps}>
      {scope.provide(children)}
      {scope.overlay}
    </div>
  );
}
