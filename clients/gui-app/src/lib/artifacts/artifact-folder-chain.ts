/**
 * The on-disk directory chain an artifact's document sits in, from the
 * client's projections - no host round trip.
 *
 * `epic.resolveArtifactByPath` resolves a folder-name chain to an artifact
 * id on the host; there is no reverse RPC (id -> path). The host states each
 * artifact's placement on the records lane, so the chain is read from it and
 * fed into the EXISTING path-shaped resolution flow. Only where the host states
 * none (the legacy root-doc arm, a records lane below 1.7, both at index epoch
 * 0) is it rebuilt from `parentId` and `folderName`.
 */
import { hostArtifactPath } from "@/lib/artifacts/artifact-placement";
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

/**
 * Root-to-leaf names of the directory `artifactId`'s document sits in: its
 * own folder, or for a file-layout artifact the folder holding its file.
 * Returns `null` when the id is unknown or the artifact has no path. Where the
 * host states no placement it also returns `null` when the tree has a cycle,
 * an ancestor isn't a projected artifact (folder-nesting is artifact-only), or
 * any folder name in the chain is empty (a legacy/malformed entry).
 */
export function artifactFolderChain(
  tree: TreeSlice,
  artifacts: ArtifactsSlice,
  artifactId: string,
): readonly string[] | null {
  if (!Object.hasOwn(artifacts.byId, artifactId)) return null;
  const artifact = artifacts.byId[artifactId];
  const host = hostArtifactPath(artifact);
  if (host.stated) {
    if (host.segments === null) return null;
    return artifact.layout === "file"
      ? host.segments.slice(0, -1)
      : host.segments;
  }

  const idsRootToLeaf: string[] = [];
  const visited = new Set<string>();
  let current: string | null = artifactId;
  while (current !== null) {
    if (visited.has(current)) return null;
    visited.add(current);
    idsRootToLeaf.unshift(current);
    if (!Object.hasOwn(tree.nodeById, current)) return null;
    current = tree.nodeById[current].parentId;
  }

  const chain: string[] = [];
  for (const id of idsRootToLeaf) {
    if (!Object.hasOwn(artifacts.byId, id)) return null;
    const folderName = artifacts.byId[id].folderName;
    if (folderName.length === 0) return null;
    chain.push(folderName);
  }
  return chain;
}
