import type { GitFileStatus } from "@traycer/protocol/host";
import type { CommandItem } from "@/lib/commands/types";

export interface PathTreeLeaf {
  readonly item: CommandItem;
  readonly path: string;
  /** Structured display segments when `/` inside a label is not a separator. */
  readonly displaySegments: ReadonlyArray<string> | null;
  /** Stable structural identity for each display segment, when not path-based. */
  readonly structuralSegments: ReadonlyArray<string> | null;
  readonly gitStatus: GitFileStatus | undefined;
}

interface DirectoryNode {
  readonly path: string;
  readonly label: string;
  readonly displayPath: string;
  readonly childDirectories: Map<string, DirectoryNode>;
  readonly leaves: PathTreeLeaf[];
  actionLeaf: PathTreeLeaf | null;
}

export function buildPathTreeItems(
  namespace: string,
  leaves: ReadonlyArray<PathTreeLeaf>,
  explicitDirectoryPaths: ReadonlyArray<string>,
): ReadonlyArray<CommandItem> {
  const root: DirectoryNode = {
    path: "",
    label: "",
    displayPath: "",
    childDirectories: new Map(),
    leaves: [],
    actionLeaf: null,
  };
  for (const directoryPath of explicitDirectoryPaths) {
    const segments = directoryPath
      .replace(/\/$/, "")
      .split("/")
      .filter((segment) => segment.length > 0);
    let directory = root;
    for (const segment of segments) {
      const path =
        directory.path.length === 0 ? segment : `${directory.path}/${segment}`;
      let child = directory.childDirectories.get(segment);
      if (child === undefined) {
        child = {
          path,
          label: segment,
          displayPath: path,
          childDirectories: new Map(),
          leaves: [],
          actionLeaf: null,
        };
        directory.childDirectories.set(segment, child);
      }
      directory = child;
    }
  }
  for (const leaf of leaves) {
    const displaySegments =
      leaf.displaySegments ??
      leaf.path.split("/").filter((segment) => segment.length > 0);
    const structuralSegments = leaf.structuralSegments ?? displaySegments;
    const segments =
      leaf.displaySegments === null
        ? structuralSegments
        : structuralSegments.map((segment) => encodeURIComponent(segment));
    let directory = root;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const path =
        directory.path.length === 0 ? segment : `${directory.path}/${segment}`;
      let child = directory.childDirectories.get(segment);
      if (child === undefined) {
        const label = displaySegments[index] ?? segment;
        const displayPath =
          directory.displayPath.length === 0
            ? label
            : `${directory.displayPath} / ${label}`;
        child = {
          path,
          label,
          displayPath,
          childDirectories: new Map(),
          leaves: [],
          actionLeaf: null,
        };
        directory.childDirectories.set(segment, child);
      }
      directory = child;
    }
    directory.leaves.push(leaf);
  }

  const structuralPath = (leaf: PathTreeLeaf): string => {
    const displaySegments =
      leaf.displaySegments ??
      leaf.path.split("/").filter((segment) => segment.length > 0);
    const structuralSegments = leaf.structuralSegments ?? displaySegments;
    return (
      leaf.displaySegments === null
        ? structuralSegments
        : structuralSegments.map((segment) => encodeURIComponent(segment))
    ).join("/");
  };
  const coalesceActionableDirectories = (directory: DirectoryNode): void => {
    for (const child of directory.childDirectories.values()) {
      const leafIndex = directory.leaves.findIndex(
        (leaf) => structuralPath(leaf) === child.path,
      );
      if (leafIndex !== -1) {
        child.actionLeaf = directory.leaves[leafIndex] ?? null;
        directory.leaves.splice(leafIndex, 1);
      }
      coalesceActionableDirectories(child);
    }
  };
  coalesceActionableDirectories(root);

  const items: CommandItem[] = [];
  const appendDirectory = (
    directory: DirectoryNode,
    ancestorIds: ReadonlyArray<string>,
  ): void => {
    const nodeId = `${namespace}:directory:${directory.path}`;
    const label = directory.label;
    const item = directory.actionLeaf?.item;
    const effectiveNodeId = item?.id ?? nodeId;
    items.push({
      ...(item ?? {
        id: nodeId,
        description: null,
        keywords: [directory.path, label],
        group: "open" as const,
        scope: "actions" as const,
        shortcut: null,
        actionId: null,
        subpage: null,
        run: () => undefined,
      }),
      id: effectiveNodeId,
      label,
      description: null,
      pathTreeRow: {
        treeId: namespace,
        nodeId: effectiveNodeId,
        depth: ancestorIds.length,
        ancestorIds,
        hasChildren: true,
        kind: item === undefined ? "directory" : "file",
        path: directory.path,
        displayPath: directory.displayPath,
      },
    });
    const nextAncestors = [...ancestorIds, effectiveNodeId];
    for (const child of directory.childDirectories.values()) {
      appendDirectory(child, nextAncestors);
    }
    appendLeaves(directory.leaves, nextAncestors);
  };
  const appendLeaves = (
    directoryLeaves: ReadonlyArray<PathTreeLeaf>,
    ancestorIds: ReadonlyArray<string>,
  ): void => {
    for (const leaf of directoryLeaves) {
      items.push({
        ...leaf.item,
        label:
          leaf.displaySegments?.at(-1) ??
          leaf.path.slice(leaf.path.lastIndexOf("/") + 1),
        pathTreeRow: {
          treeId: namespace,
          nodeId: leaf.item.id,
          depth: ancestorIds.length,
          ancestorIds,
          hasChildren: false,
          kind: "file",
          path: leaf.path,
          displayPath:
            leaf.displaySegments === null
              ? leaf.path
              : leaf.displaySegments.join(" / "),
          gitStatus: leaf.gitStatus,
        },
      });
    }
  };
  for (const directory of root.childDirectories.values()) {
    appendDirectory(directory, []);
  }
  appendLeaves(root.leaves, []);
  return items;
}

/** Preserve an authoritative search order while retaining file-row visuals. */
export function buildRankedPathItems(
  namespace: string,
  leaves: ReadonlyArray<PathTreeLeaf>,
): ReadonlyArray<CommandItem> {
  return leaves.map((leaf) => ({
    ...leaf.item,
    label:
      leaf.displaySegments === null
        ? leaf.path
        : leaf.displaySegments.join(" / "),
    pathTreeRow: {
      treeId: namespace,
      nodeId: leaf.item.id,
      depth: 0,
      ancestorIds: [],
      hasChildren: false,
      kind: "file",
      path: leaf.path,
      displayPath:
        leaf.displaySegments === null
          ? leaf.path
          : leaf.displaySegments.join(" / "),
      gitStatus: leaf.gitStatus,
    },
  }));
}

export function openerPathTreeId(
  kind: "files" | "diff",
  hostId: string,
  workspacePath: string,
): string {
  return `open:${kind}:${encodeURIComponent(hostId)}:${encodeURIComponent(workspacePath)}`;
}
