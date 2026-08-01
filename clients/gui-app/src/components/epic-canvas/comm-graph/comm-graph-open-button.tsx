/**
 * Opens the epic's communication graph from the Agents panel header.
 *
 * The graph used to have its own sidebar rail entry, which put a whole panel in
 * the rail for something that is one canvas. It lives here instead because the
 * Agents panel is already the list of the things the graph draws - the button is
 * "see these as a graph", next to the other controls that act on that list.
 *
 * DEDUPING BY CONSTRUCTION: `makeCommGraphTileRef` derives the tile's content id
 * from the epic, and `openTile` focuses an existing tab with that id rather than
 * minting a second one. That matters beyond tidiness - per-tile state keyed on
 * the content id (the graph's persisted viewport) would otherwise be written by
 * two tabs at once, so panning one would move the other.
 */
import { Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useOpenCommunicationGraph } from "./use-open-communication-graph";

export interface CommGraphOpenButtonProps {
  readonly epicId: string;
  readonly disabled: boolean;
  /** Header-action reveal/compact classes, owned by the sidebar. */
  readonly className: string;
}

export function CommGraphOpenButton(props: CommGraphOpenButtonProps) {
  const { className, disabled, epicId } = props;
  const openGraph = useOpenCommunicationGraph(epicId);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Open communication graph"
      data-testid="epic-sidebar-open-comm-graph"
      disabled={disabled}
      onClick={openGraph}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <Waypoints className="size-4" />
    </Button>
  );
}

export function CommGraphOpenMenuItem(props: {
  readonly epicId: string;
  readonly disabled: boolean;
}) {
  const openGraph = useOpenCommunicationGraph(props.epicId);

  return (
    <DropdownMenuItem
      disabled={props.disabled}
      onSelect={openGraph}
      data-testid="epic-sidebar-more-open-comm-graph"
    >
      <Waypoints className="size-4" />
      Open communication graph
    </DropdownMenuItem>
  );
}
