import type { ReactNode } from "react";
import { EpicPlaybackControls } from "@/components/epic-canvas/panels/epic-playback-controls";

/**
 * The frame of a task's status row, and the music's place in it, ahead of the
 * items that say something about the task. It is a container so that those
 * controls can give way when the row runs short of room.
 */
export function EpicStatusRow(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <output
      data-testid="epic-shell-status-row"
      // The phone single-tile design has no status row; the global mobile
      // header carries app-wide status instead. Desktop (>=768px) is unchanged.
      className="@container flex h-10 shrink-0 items-center justify-end gap-1.5 px-3 text-foreground max-md:hidden"
    >
      <EpicPlaybackControls />
      {props.children}
    </output>
  );
}
