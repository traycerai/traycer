import type { ReactNode } from "react";

/**
 * Tracy's bots list when level 2 draws beside the content or under the current
 * item's name (a task's tile list is the sheet in every form). The width is
 * the resolver's answer in CSS pixels, never a choice made here. It paints the
 * sidebar's fill, as the task's panel and Tracy's desktop column do, so a side
 * strip's row runs into it in that fill (`surfaceJoinPane`).
 */
export function MobileLevel2Column(props: {
  readonly width: number;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      style={{ width: props.width }}
      className="flex min-h-0 shrink-0 flex-col border-r border-canvas-border/70 bg-(--sidebar)"
    >
      {props.children}
    </div>
  );
}
