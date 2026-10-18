import { isArtifactPath } from "./artifact-address";

export interface ArtifactManifestEntry {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface ArtifactManifest {
  readonly files: Readonly<Record<string, ArtifactManifestEntry>>;
}

export function resolveManifestPath(
  manifest: ArtifactManifest,
  path: string,
): ArtifactManifestEntry | null {
  if (!isArtifactPath(path) || !Object.hasOwn(manifest.files, path)) return null;
  return manifest.files[path];
}
