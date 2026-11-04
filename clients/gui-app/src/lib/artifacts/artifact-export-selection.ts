import { displayTitle } from "@/lib/display-title";
import { isMarkdownArtifactKind } from "@/lib/artifacts/node-display";
import type { ArtifactsSlice, TreeSlice } from "@/stores/epics/open-epic/types";

/** The two projected slices a nested export walks. */
export interface ArtifactExportTree {
  readonly artifacts: ArtifactsSlice;
  readonly tree: TreeSlice;
}

export interface ArtifactExportPick {
  readonly id: string;
  readonly title: string;
}

export interface NestedArtifactExportEntry extends ArtifactExportPick {
  /** Nearest exported ancestor in this selection, or `null` for a root. */
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
 * The picked artifacts plus every Markdown artifact nested under them, in tree
 * order, each linked to its nearest exported ancestor.
 *
 * A pick nested under another pick is reached from that ancestor instead of
 * standing as its own root, so it exports once and in place. A non-Markdown
 * artifact in between (an HTML page, a file) has no document body and is left
 * out, but the walk continues through it: its Markdown children attach to the
 * nearest ancestor that IS exported. Chats and agents in the tree are not
 * artifacts and are not walked. A pick the tree does not hold yet exports on
 * its own, as it would without nesting.
 */
export function expandNestedArtifactExport(
  tree: ArtifactExportTree,
  picks: ReadonlyArray<ArtifactExportPick>,
): NestedArtifactExportEntry[] {
  const pickedIds = new Set(picks.map((pick) => pick.id));
  const entries: NestedArtifactExportEntry[] = [];
  const visited = new Set<string>();
  const walkChildren = (id: string, exportedParentId: string): void => {
    for (const childId of artifactChildIds(tree, id)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      const child = tree.artifacts.byId[childId];
      if (isMarkdownArtifactKind(child.kind)) {
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
  // A pick whose picked ancestor's walk never reached it (the ancestor was a
  // non-Markdown artifact the caller filtered out, or the chain runs through
  // a chat) would otherwise be dropped; it exports at the top level instead.
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
