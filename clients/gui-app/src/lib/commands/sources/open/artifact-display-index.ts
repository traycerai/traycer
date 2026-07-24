/**
 * Display index for the Files opener's Epic-artifacts step: a
 * `logicalPath -> { id, kind, title, titlePath }` map for rendering + opening a
 * `workspace.searchPaths` artifact result.
 *
 * Path resolution is delegated to the SHARED, fail-closed
 * {@link buildArtifactPathIndex} (Ticket 7's `artifact-path-resolver.ts`) so the
 * two opener flows cannot diverge: a logical path claimed by two or more live
 * artifacts is ambiguous and resolves to NO identity (never first/last-writer
 * wins), so an ambiguous result opens nothing. This module only layers the
 * display fields the Files rows need on top of that shared resolution: the
 * user-facing {@link displayTitle} and an ancestor-title path that distinguishes
 * duplicate leaf titles.
 */
import { displayTitle } from "@/lib/display-title";
import { buildArtifactPathIndex } from "@/lib/commands/sources/open/artifact-path-resolver";
import type {
  ArtifactsSlice,
  TreeSlice,
} from "@/stores/epics/open-epic/types";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";

export interface ArtifactPathEntry {
  readonly id: string;
  readonly kind: EpicArtifactKind;
  /** Display title of the leaf artifact (host-independent, user-renamed). */
  readonly title: string;
  /**
   * Ancestor-to-leaf display titles joined by " / ". Distinguishes duplicate
   * leaf titles by their parent context and reads better than the folder slug
   * path, while the slug path stays available as a search keyword.
   */
  readonly titlePath: string;
}

export function buildArtifactDisplayPathIndex(
  tree: TreeSlice,
  artifacts: ArtifactsSlice,
): ReadonlyMap<string, ArtifactPathEntry> {
  const resolution = buildArtifactPathIndex(tree, artifacts);
  const index = new Map<string, ArtifactPathEntry>();
  for (const [logicalPath, resolved] of resolution) {
    index.set(logicalPath, {
      id: resolved.id,
      kind: resolved.kind,
      title: displayTitle(resolved.title, resolved.kind),
      titlePath: artifactTitlePath(tree, artifacts, resolved.id),
    });
  }
  return index;
}

/** Root-to-leaf display titles for `artifactId`, joined by " / ". */
function artifactTitlePath(
  tree: TreeSlice,
  artifacts: ArtifactsSlice,
  artifactId: string,
): string {
  const titles: string[] = [];
  const visited = new Set<string>();
  let current: string | null = artifactId;
  while (current !== null) {
    if (visited.has(current)) break;
    visited.add(current);
    if (Object.hasOwn(artifacts.byId, current)) {
      const artifact = artifacts.byId[current];
      titles.unshift(displayTitle(artifact.title, artifact.kind));
    }
    current = Object.hasOwn(tree.nodeById, current)
      ? tree.nodeById[current].parentId
      : null;
  }
  return titles.join(" / ");
}

/** Strip leading/trailing slashes so client + host path forms compare equal. */
export function normalizeArtifactLogicalPath(rawRelPath: string): string {
  return rawRelPath.replace(/^\/+/, "").replace(/\/+$/, "");
}
