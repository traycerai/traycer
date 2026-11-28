import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import type {
  ArtifactManifest,
  ArtifactOutsideReferenceResolver,
  ArtifactManifestEntry,
} from "@/lib/sandbox/artifact-serving";
import { isArtifactPath } from "@/lib/sandbox/artifact-serving/artifact-address";
import { hostArtifactPath } from "@/lib/artifacts/artifact-placement";

/**
 * The artifact's path from the artifacts root, as the host placed it. Where
 * the host states no placement it is rebuilt from the stored fields:
 * `relativePath` carries plain-folder prefixes; `folderName` remains the
 * display leaf.
 */
export function artifactTreePath(
  artifacts: ArtifactsSlice,
  artifactId: string,
): string | null {
  if (!Object.hasOwn(artifacts.byId, artifactId)) return null;
  const host = hostArtifactPath(artifacts.byId[artifactId]);
  if (host.stated) {
    if (host.segments === null) return null;
    const placed = host.segments.join("/");
    return isArtifactPath(placed) ? placed : null;
  }
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: string | null = artifactId;
  while (current !== null) {
    if (visited.has(current) || !Object.hasOwn(artifacts.byId, current))
      return null;
    visited.add(current);
    const entry: ArtifactProjection = artifacts.byId[current];
    if (entry.layout === "file" && current !== artifactId) return null;
    segments.unshift(entry.relativePath ?? entry.folderName);
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
  if (artifact.layout !== "file")
    return { treePath: path, entryPath: "index.html" };
  // A placed file-layout artifact is the file at its placed path, sibling
  // suffix included; the stored name is not where it is.
  if (hostArtifactPath(artifact).stated) {
    const cut = path.lastIndexOf("/");
    return cut < 0
      ? { treePath: "", entryPath: path }
      : { treePath: path.slice(0, cut), entryPath: path.slice(cut + 1) };
  }
  const entryPath = artifact.relativePath ?? artifact.folderName;
  return {
    treePath: path.slice(0, path.length - entryPath.length).replace(/\/$/, ""),
    entryPath,
  };
}

/**
 * The only file a file-layout artifact's manifest holds, whatever its key:
 * the key is the name the file had on whichever host captured that version,
 * so it says nothing about where the file is now. None or several cannot be
 * placed, which is how the host materializes them too.
 */
function soleManifestEntry(
  manifest: ArtifactManifest,
): ArtifactManifestEntry | null {
  const entries = Object.values(manifest.files);
  return entries.length === 1 ? entries[0] : null;
}

/**
 * What a mounted artifact serves: `manifest` below the mount's tree path, and
 * the document to open first (`versionEntryPath` when a past version names
 * one). A file-layout artifact the host placed is served the way the host
 * materializes it, its sole manifest entry at the placed name; `null` when it
 * has none or several.
 */
export function servedArtifactDocument(
  artifact: ArtifactProjection,
  paths: { readonly treePath: string; readonly entryPath: string },
  manifest: ArtifactManifest,
  versionEntryPath: string | null,
): {
  readonly manifest: ArtifactManifest;
  readonly treePath: string;
  readonly entryPath: string;
} | null {
  if (artifact.layout !== "file" || !hostArtifactPath(artifact).stated) {
    return {
      manifest,
      treePath: paths.treePath,
      entryPath: versionEntryPath ?? paths.entryPath,
    };
  }
  const entry = soleManifestEntry(manifest);
  if (entry === null) return null;
  return {
    manifest: { ...manifest, files: { [paths.entryPath]: entry } },
    treePath: paths.treePath,
    entryPath: paths.entryPath,
  };
}

/** Resolve only paths advertised by the current projection, never arbitrary disk paths. */
export function createArtifactOutsideReferenceResolver(
  artifacts: ArtifactsSlice,
): ArtifactOutsideReferenceResolver {
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
      if (artifact.object !== undefined) {
        add(path, artifact.object);
      }
    } else if (
      (artifact.kind === "html" || artifact.kind === "canvas") &&
      artifact.head !== undefined
    ) {
      if (artifact.layout === "file" && hostArtifactPath(artifact).stated) {
        // Placed: the one file, at its placed path.
        const entry = soleManifestEntry(artifact.head);
        if (entry !== null) add(path, entry);
        continue;
      }
      for (const [file, entry] of Object.entries(artifact.head.files)) {
        // File-layout heads are relative to the parent artifact folder.
        const target =
          artifact.layout === "file"
            ? `${path.slice(0, path.length - (artifact.relativePath ?? artifact.folderName).length)}${file}`
            : `${path}/${file}`;
        add(target, entry);
      }
    }
  }
  return (path) => (isArtifactPath(path) ? (entries.get(path) ?? null) : null);
}
