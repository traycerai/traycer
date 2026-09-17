import type { DraftPublication } from "@traycer/protocol/host";

export function draftPublicationLabel(
  publication: DraftPublication | null,
): string | null {
  if (publication === null) return null;
  if (publication.halted !== null) {
    if (publication.halted.cause === "stale-authority") return null;
    return "Backup paused";
  }
  if (publication.status === "current") return "Backed up";
  if (publication.status === "behind") return "Backing up…";
  return null;
}
