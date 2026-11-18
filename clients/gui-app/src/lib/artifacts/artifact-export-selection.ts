import { displayTitle } from "@/lib/display-title";
import { isMarkdownArtifactKind } from "@/lib/artifacts/node-display";
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

/** The two projected slices an export walks to lay itself out as the tree. */
export interface ArtifactExportTree {
  readonly artifacts: ArtifactsSlice;
  readonly tree: TreeSlice;
}

export interface ArtifactExportPick {
  readonly id: string;
  readonly title: string;
}

export interface ArtifactExportEntry extends ArtifactExportPick {
  /** Nearest exported ancestor in this export, or `null` for a root. */
  readonly parentId: string | null;
}

function artifactChildIds(
  tree: ArtifactExportTree,
  id: string,
): readonly string[] {
  if (!Object.hasOwn(tree.tree.childrenByParent, id)) return [];
  return tree.tree.childrenByParent[id].filter((childId) =>
    Object.hasOwn(tree.artifacts.byId, childId),
  );
}

function treeParentId(tree: ArtifactExportTree, id: string): string | null {
  return Object.hasOwn(tree.tree.nodeById, id)
    ? tree.tree.nodeById[id].parentId
    : null;
}

function hasPickedAncestor(
  tree: ArtifactExportTree,
  id: string,
  picked: ReadonlySet<string>,
): boolean {
  const seen = new Set([id]);
  let parentId = treeParentId(tree, id);
  while (parentId !== null && !seen.has(parentId)) {
    if (picked.has(parentId)) return true;
    seen.add(parentId);
    parentId = treeParentId(tree, parentId);
  }
  return false;
}

/**
 * What an export writes, in tree order, each entry linked to its nearest
 * exported ancestor so the archive unpacks as the tree.
 *
 * Every pick exports once. A pick nested under another pick is reached from
 * that ancestor instead of standing as its own root, so it lands in place.
 * `includeNested` also exports every Markdown artifact under a pick; without
 * it only the picks are written, and an unpicked artifact between two picks
 * links the lower one to the upper. A non-Markdown artifact (an HTML page, a
 * file) is never added - it has no document body - but the walk continues
 * through it. Chats and agents in the tree are not artifacts and are not
 * walked. A pick the tree does not hold yet exports on its own.
 */
export function arrangeArtifactExport(
  tree: ArtifactExportTree,
  picks: ReadonlyArray<ArtifactExportPick>,
  includeNested: boolean,
): ArtifactExportEntry[] {
  const pickById = new Map(picks.map((pick) => [pick.id, pick]));
  const pickedIds = new Set(pickById.keys());
  const entries: ArtifactExportEntry[] = [];
  const visited = new Set<string>();
  const walkChildren = (id: string, exportedParentId: string): void => {
    for (const childId of artifactChildIds(tree, id)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      const pick = pickById.get(childId);
      const child = tree.artifacts.byId[childId];
      // A pick is written whatever its kind, so the caller's Markdown check
      // refuses a stale non-Markdown pick instead of it silently vanishing.
      if (pick !== undefined) {
        entries.push({
          id: pick.id,
          title: pick.title,
          parentId: exportedParentId,
        });
        walkChildren(childId, childId);
      } else if (includeNested && isMarkdownArtifactKind(child.kind)) {
        entries.push({
          id: childId,
          title: displayTitle(child.title, child.kind),
          parentId: exportedParentId,
        });
        walkChildren(childId, childId);
      } else {
        walkChildren(childId, exportedParentId);
      }
    }
  };
  for (const pick of picks) {
    if (visited.has(pick.id) || hasPickedAncestor(tree, pick.id, pickedIds)) {
      continue;
    }
    visited.add(pick.id);
    entries.push({ id: pick.id, title: pick.title, parentId: null });
    walkChildren(pick.id, pick.id);
  }
  // A pick whose picked ancestor's walk never reached it (the chain between
  // them runs through a chat, or through an artifact whose record has not
  // arrived) would otherwise be dropped; it exports at the top level instead.
  for (const pick of picks) {
    if (visited.has(pick.id)) continue;
    visited.add(pick.id);
    entries.push({ id: pick.id, title: pick.title, parentId: null });
    walkChildren(pick.id, pick.id);
  }
  return entries;
}

/** Whether a nested export of `id` would carry anything beyond `id` itself. */
export function hasNestedMarkdownArtifacts(
  tree: ArtifactExportTree,
  id: string,
): boolean {
  const seen = new Set([id]);
  const pending = [...artifactChildIds(tree, id)];
  while (pending.length > 0) {
    const childId = pending.pop();
    if (childId === undefined || seen.has(childId)) continue;
    seen.add(childId);
    if (isMarkdownArtifactKind(tree.artifacts.byId[childId].kind)) return true;
    pending.push(...artifactChildIds(tree, childId));
  }
  return false;
}
