import type { ArtifactObjectRef } from "@traycer/protocol/persistence/epic/artifacts";
import { isArtifactPath } from "./artifact-address";

export type ArtifactManifestEntry = Readonly<
  Pick<ArtifactObjectRef, "sha256" | "byteLength" | "mediaType"> & {
    // A chat stamp is a historical manifest snapshot and deliberately omits
    // mutable upload status. Absence means unknown from this source, never a state.
    status?: ArtifactObjectRef["status"];
  }
>;

export interface ArtifactManifest {
  readonly files: Readonly<Record<string, ArtifactManifestEntry>>;
}

export function resolveManifestPath(
  manifest: ArtifactManifest,
  path: string,
): ArtifactManifestEntry | null {
  if (!isArtifactPath(path) || !Object.hasOwn(manifest.files, path))
    return null;
  return manifest.files[path];
}
