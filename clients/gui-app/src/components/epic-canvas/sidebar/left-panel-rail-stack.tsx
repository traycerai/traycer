import type { ReactNode } from "react";

/**
 * A stack on the rail, drawn as ONE view group (G3, L-181), the way VS Code
 * draws a view container: the icon of the stack's top panel stands for every
 * member, its name lists them ("Agents · Artifacts · Terminals"), and clicking
 * it opens the body they share. Which icon shows is the user's choice of
 * order: the panel on top of the stack is the one the rail draws.
 *
 * At rest that is all there is. While the layout editor is customizing this
 * rail the grouping has to stay visible, since the inspector's Position list
 * edits it, so the icon carries a small count of the panels it stands for. It
 * sits at the tile's top corner, clear of both rails' active marks: the
 * horizontal rail's underline and the vertical rail's edge bar.
 *
 * One component for all three rails - the epic sidebar's, the sample
 * workspace's and the preset card's miniature - because it draws the same fact
 * about `arrangement.rail` in each.
 */
export function LeftPanelRailStack(props: {
  readonly stackId: string;
  /** How many panels the icon stands for, drawn only while `showCount`. */
  readonly memberCount: number;
  readonly showCount: boolean;
  /** The top panel's icon. */
  readonly children: ReactNode;
}) {
  return (
    <div
      data-rail-stack={props.stackId}
      data-testid="epic-rail-stack"
      className="relative flex shrink-0"
    >
      {props.children}
      {props.showCount ? (
        <span
          aria-hidden
          data-testid="epic-rail-stack-count"
          className="pointer-events-none absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground/80 px-0.5 text-[0.5625rem] leading-none font-semibold text-background tabular-nums ring-2 ring-background"
        >
          {props.memberCount}
        </span>
      ) : null}
    </div>
  );
}
