import { artifactLinkPathRootAgnostic } from "@traycer/protocol/common/artifact-path";

/** Recognize artifact file and folder links independently of their disk root. */
export function artifactEpicIdFromLinkPath(filePath: string): string | null {
  return artifactLinkPathRootAgnostic(filePath, null)?.epicId ?? null;
}
