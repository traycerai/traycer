/**
 * Resolve a text-search result's LOGICAL artifact path back to the authoritative artifact identity in live Yjs Epic state.
 */
import { useCallback, useMemo } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { artifactFolderChain } from "@/lib/artifacts/artifact-folder-chain";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

export interface ResolvedArtifact {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  readonly title: string;
}

/**
 * Build a `logicalPath -> { id, kind, title }` index for every live artifact whose folder chain resolves.
 * Artifacts with an unresolvable chain (unknown ancestor, cycle, empty folder name) are skipped, matching the host, which can only project a mirror path from a well-formed chain.
 */
export function buildArtifactPathIndex(
  tree: TreeSlice | null,
  artifacts: ArtifactsSlice | null,
): Map<string, ResolvedArtifact> {
  const index = new Map<string, ResolvedArtifact>();
  if (tree === null || artifacts === null) return index;
  const ambiguous = new Set<string>();
  for (const id of artifacts.allIds) {
    const chain = artifactFolderChain(tree, artifacts, id);
    if (chain === null) continue;
    const key = chain.join("/");
    if (ambiguous.has(key)) continue;
    if (index.has(key)) {
      // A second artifact claims this path: drop it entirely and remember it so a later third claimant does not re-add it.
      // `.get()` then misses no matter the iteration order - fail closed, never first/last wins.
      index.delete(key);
      ambiguous.add(key);
      continue;
    }
    const artifact = artifacts.byId[id];
    index.set(key, {
      id,
      kind: artifact.kind,
      title: artifact.title,
    });
  }
  return index;
}

/**
 * Returns a resolver from a logical artifact path to its authoritative identity, or `null` when no live artifact occupies that path (stale/deleted result).
 */
export function useArtifactPathResolver(
  epicId: string | null,
): (logicalPath: string) => ResolvedArtifact | null {
  const projection = useActiveEpicProjection(epicId);
  const index = useMemo(
    () =>
      buildArtifactPathIndex(
        projection?.tree ?? null,
        projection?.artifacts ?? null,
      ),
    [projection],
  );
  return useCallback(
    (logicalPath: string) => index.get(logicalPath) ?? null,
    [index],
  );
}
