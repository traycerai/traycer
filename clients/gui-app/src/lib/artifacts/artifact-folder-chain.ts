/**
 * Reconstructs the on-disk folder-name chain for an artifact from the client's own tree + artifact projections - no host round trip.
 */
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

/**
 * Root-to-leaf folder names for `artifactId`, ending with its own `folderName`.
 * Returns `null` when the id is unknown, the tree has a cycle, an ancestor isn't a projected artifact (folder-nesting is artifact-only), or any folder name in the chain is empty (a legacy/malformed entry).
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
