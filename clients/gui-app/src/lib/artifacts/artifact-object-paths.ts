import type { ArtifactProjection, ArtifactsSlice } from "@/stores/epics/open-epic/types";
import type { ArtifactOutsideReferenceResolver, ArtifactManifestEntry } from "@/lib/sandbox/artifact-serving";
import { isArtifactPath } from "@/lib/sandbox/artifact-serving/artifact-address";

/** A loose file uses its parent's folder, never its own display slug. */
export function artifactTreePath(artifacts: ArtifactsSlice, artifactId: string): string | null {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: string | null = artifactId;
  while (current !== null) {
    if (visited.has(current) || !Object.hasOwn(artifacts.byId, current)) return null;
    visited.add(current);
    const entry: ArtifactProjection = artifacts.byId[current];
    if (entry.layout === "file") {
      if (current !== artifactId || entry.relativePath === undefined) return null;
      segments.unshift(entry.relativePath);
    } else {
      segments.unshift(entry.folderName);
    }
    current = entry.parentId;
  }
  const path = segments.join("/");
  return isArtifactPath(path) ? path : null;
}

/** The mount's folder and initial document path, shared by tiles and chat embeds. */
export function artifactSourcePathsFor(
  artifact: ArtifactProjection,
  artifacts: ArtifactsSlice,
): { readonly treePath: string; readonly entryPath: string } | null {
  const path = artifactTreePath(artifacts, artifact.id);
  if (path === null) return null;
  const entryPath = artifact.layout === "file" ? artifact.relativePath : "index.html";
  if (entryPath === undefined) return null;
  const treePath = artifact.layout === "file"
    ? path.slice(0, path.length - entryPath.length).replace(/\/$/, "")
    : path;
  return { treePath, entryPath };
}

/** Resolve only paths advertised by the current projection, never arbitrary disk paths. */
export function createArtifactOutsideReferenceResolver(artifacts: ArtifactsSlice): ArtifactOutsideReferenceResolver {
  const entries = new Map<string, ArtifactManifestEntry>();
  const ambiguous = new Set<string>();
  const add = (path: string, entry: ArtifactManifestEntry): void => {
    if (!isArtifactPath(path) || ambiguous.has(path)) return;
    if (entries.has(path)) {
      entries.delete(path);
      ambiguous.add(path);
    } else {
      entries.set(path, entry);
    }
  };
  for (const id of artifacts.allIds) {
    const path = artifactTreePath(artifacts, id);
    if (path === null) continue;
    const artifact = artifacts.byId[id];
    if (artifact.kind === "file") {
      if (artifact.sha256 !== undefined && artifact.byteLength !== undefined && artifact.mediaType !== undefined) {
        add(path, { sha256: artifact.sha256, byteLength: artifact.byteLength, mediaType: artifact.mediaType });
      }
    } else if ((artifact.kind === "html" || artifact.kind === "canvas") && artifact.head !== undefined) {
      for (const [file, entry] of Object.entries(artifact.head.files)) {
        // File-layout heads are relative to the parent artifact folder.
        const target = artifact.layout === "file"
          ? `${path.slice(0, path.length - (artifact.relativePath?.length ?? 0))}${file}`
          : `${path}/${file}`;
        add(target, entry);
      }
    }
  }
  return path => isArtifactPath(path) ? entries.get(path) ?? null : null;
}
