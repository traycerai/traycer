import { useCloseTilesOnTeamRemoval } from "@/hooks/teams/use-close-tiles-on-team-removal";

/** Mounts the removed-member tile close app-wide. */
export function TeamRemovalTileCloser(): null {
  useCloseTilesOnTeamRemoval();
  return null;
}
