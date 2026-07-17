/**
 * Reconstructs the on-disk folder-name chain for an artifact from the
 * client's own tree + artifact projections - no host round trip.
 *
 * `epic.resolveArtifactByPath` resolves a folder-name chain to an artifact
 * id via a Y.Doc index walk on the host; there is no reverse RPC (id ->
 * path). Both `parentId` (tree) and `folderName` (artifact metadata) are
 * already projected client-side, so the chain can be rebuilt locally and fed
 * into the EXISTING path-shaped resolution flow instead of adding a new host
 * RPC (the host lives in a separate, closed-source repo this change cannot
 * touch).
 */
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

/**
 * Root-to-leaf folder names for `artifactId`, ending with its own
 * `folderName`. Returns `null` when the id is unknown, the tree has a cycle,
 * an ancestor isn't a projected artifact (folder-nesting is artifact-only),
 * or any folder name in the chain is empty (a legacy/malformed entry).
 */
export function artifactFolderChain(
  tree: TreeSlice,
  artifacts: ArtifactsSlice,
  artifactId: string,
): readonly string[] | null {
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
