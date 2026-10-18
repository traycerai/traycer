import type { ReactNode } from "react";

/**
 * A file viewer's one toolbar (Viewers): what the file is on the left, the
 * viewer's controls and the tile's actions on the right. The same row the image
 * viewer draws, for the kinds and states that have no richer one. The caption
 * keeps a few characters of room; on a narrow tile the actions wrap below it
 * rather than push it out.
 */
export function ViewerToolbar(props: {
  readonly caption: ReactNode;
  readonly actions: ReactNode;
}): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label="File controls"
      className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-canvas-border/70 px-2 py-0.5"
    >
      <span className="min-w-16 grow basis-0 truncate text-ui-xs text-muted-foreground">
        {props.caption}
      </span>
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {props.actions}
      </div>
    </div>
  );
}
