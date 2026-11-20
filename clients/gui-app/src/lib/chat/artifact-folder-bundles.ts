import type {
  CheckpointArtifactTag,
  CheckpointFileOperation,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";

type FolderArtifactKind = "html" | "canvas";

const LEAD_FILE_BASENAME = {
  html: "index.html",
  canvas: "canvas.json",
} satisfies Readonly<Record<FolderArtifactKind, string>>;

export interface ArtifactFolderMember<T> {
  readonly item: T;
  /** The member's path below the bundle's longest common directory. */
  readonly label: string;
}

/**
 * Every changed file of one html or canvas artifact, shown as a single row:
 * the person thinks in the artifact, not in the files of its folder.
 */
export interface ArtifactFolderBundle<T> {
  readonly kind: "bundle";
  readonly artifactId: string;
  readonly artifactKind: FolderArtifactKind;
  readonly title: string | null;
  /**
   * The lead file's operation when it changed (the artifact was created or
   * deleted only if its `index.html` / `canvas.json` was), else `"edit"`.
   */
  readonly operation: CheckpointFileOperation;
  readonly members: ReadonlyArray<ArtifactFolderMember<T>>;
}

export type ArtifactFolderGrouping<T> =
  | { readonly kind: "single"; readonly item: T }
  | ArtifactFolderBundle<T>;

interface GroupableChange {
  readonly filePath: string;
  readonly operation: CheckpointFileOperation;
}

/**
 * Collapses the changes of each html / canvas artifact into one bundle at the
 * position of its first change; every other item passes through in place.
 * The one grouping rule behind the per-turn "Changes" block, the "Files
 * changed" panel and the restore dialog, so the three cannot disagree on what
 * an artifact row is. An unresolved tag (`kind` or `artifactId` null) stays a
 * single row, as does every markdown and `file` artifact.
 */
export function groupArtifactFolderChanges<T extends GroupableChange>(
  items: ReadonlyArray<T>,
  artifactOf: (item: T) => CheckpointArtifactTag | null,
): ReadonlyArray<ArtifactFolderGrouping<T>> {
  const order: Array<
    { readonly kind: "single"; readonly item: T } | PendingBundle<T>
  > = [];
  const pendingByArtifactId = new Map<string, PendingBundle<T>>();
  for (const item of items) {
    const tag = artifactOf(item);
    const artifactKind = tag === null ? null : folderArtifactKind(tag.kind);
    if (tag === null || tag.artifactId === null || artifactKind === null) {
      order.push({ kind: "single", item });
      continue;
    }
    const pending = pendingByArtifactId.get(tag.artifactId);
    if (pending === undefined) {
      const created: PendingBundle<T> = {
        kind: "pending",
        artifactId: tag.artifactId,
        artifactKind,
        title: tag.title,
        items: [item],
      };
      order.push(created);
      pendingByArtifactId.set(tag.artifactId, created);
      continue;
    }
    pending.items.push(item);
    pending.title ??= tag.title;
  }
  return order.map((entry): ArtifactFolderGrouping<T> =>
    entry.kind === "single"
      ? entry
      : {
          kind: "bundle",
          artifactId: entry.artifactId,
          artifactKind: entry.artifactKind,
          title: entry.title,
          operation: bundleOperation(entry.artifactKind, entry.items),
          members: memberLabels(entry.items),
        },
  );
}

interface PendingBundle<T> {
  readonly kind: "pending";
  readonly artifactId: string;
  readonly artifactKind: FolderArtifactKind;
  title: string | null;
  readonly items: T[];
}

/**
 * How many artifacts the tagged items belong to, which is what every "Also
 * revert N artifacts" opt-out counts: the files of one html or canvas artifact
 * share its id. An entry whose id was unresolved when it was captured takes
 * the id another entry for the same path resolved to, else counts on its own.
 */
export function distinctArtifactCount(
  items: ReadonlyArray<{
    readonly filePath: string;
    readonly artifact?: CheckpointArtifactTag | null;
  }>,
): number {
  const resolvedIdByPath = new Map<string, string>();
  for (const item of items) {
    if (item.artifact?.artifactId) {
      resolvedIdByPath.set(item.filePath, item.artifact.artifactId);
    }
  }
  const artifactKeys = new Set<string>();
  for (const item of items) {
    if (!item.artifact) continue;
    const artifactId =
      item.artifact.artifactId ?? resolvedIdByPath.get(item.filePath);
    artifactKeys.add(
      artifactId === undefined ? `path:${item.filePath}` : `id:${artifactId}`,
    );
  }
  return artifactKeys.size;
}

function folderArtifactKind(
  kind: CheckpointArtifactTag["kind"],
): FolderArtifactKind | null {
  return kind === "html" || kind === "canvas" ? kind : null;
}

function pathSegments(filePath: string): ReadonlyArray<string> {
  return filePath.split(/[\\/]/);
}

function bundleOperation(
  artifactKind: FolderArtifactKind,
  items: ReadonlyArray<GroupableChange>,
): CheckpointFileOperation {
  // A nested folder holding its own lead file is a child artifact with its
  // own id, so at most one member carries the lead file's name.
  const lead = items.find(
    (item) =>
      pathSegments(item.filePath).at(-1) === LEAD_FILE_BASENAME[artifactKind],
  );
  return lead?.operation ?? "edit";
}

function memberLabels<T extends GroupableChange>(
  items: ReadonlyArray<T>,
): ReadonlyArray<ArtifactFolderMember<T>> {
  const segmentsPerItem = items.map((item) => pathSegments(item.filePath));
  const directories = segmentsPerItem.map((segments) => segments.slice(0, -1));
  const commonDepth = directories.reduce(
    (depth, directory) => commonPrefixLength(directories[0], directory, depth),
    directories[0].length,
  );
  return items.map((item, index) => ({
    item,
    label: segmentsPerItem[index].slice(commonDepth).join("/"),
  }));
}

function commonPrefixLength(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  limit: number,
): number {
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}
