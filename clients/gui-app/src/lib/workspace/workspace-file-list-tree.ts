/** Pure projection helpers for the `workspace.subscribeFileList` stream. */
import type { WorkspaceFileListEntry } from "@traycer/protocol/host/workspace/subscribe";

/** The workspace root's directory token; always covered while a stream is open. */
export const WORKSPACE_FILE_LIST_ROOT_PATH = "";

export interface WorkspaceFileListDirectoryListing {
  readonly entries: ReadonlyArray<WorkspaceFileListEntry>;
  readonly truncated: boolean;
}

export interface WorkspaceFileListProjection {
  /** Flat path list for the tree adapter: every entry of every covered listing. */
  readonly paths: ReadonlyArray<string>;
  /** Non-directory entries only - a path absent here is not openable. */
  readonly fileNameByPath: ReadonlyMap<string, string>;
  /** Paths git ignores, for display dimming. Never used to filter rows. */
  readonly ignoredPaths: ReadonlyArray<string>;
  /** True when any covered directory held more children than the host's cap. */
  readonly truncated: boolean;
}

/**
 * True when `path` is `directoryPath` itself or lives underneath it.
 * Both arguments are directory tokens, so the trailing slash makes a prefix test exact (`"src/"` never matches `"src-gen/x"`); the root token `""` is a prefix of everything, which is what "the workspace root vanished" means.
 */
export function isWithinDirectory(
  path: string,
  directoryPath: string,
): boolean {
  return path.startsWith(directoryPath);
}

/**
 * The parent directory token of a directory token, or `null` for the root (and for any non-canonical input, which never comes off the wire).
 */
export function parentDirectoryPathOf(directoryPath: string): string | null {
  if (directoryPath.length === 0 || !directoryPath.endsWith("/")) return null;
  const withoutTrailingSlash = directoryPath.slice(0, -1);
  const lastSlash = withoutTrailingSlash.lastIndexOf("/");
  return lastSlash === -1
    ? WORKSPACE_FILE_LIST_ROOT_PATH
    : withoutTrailingSlash.slice(0, lastSlash + 1);
}

function directoryDepthOf(directoryPath: string): number {
  let depth = 0;
  for (const character of directoryPath) if (character === "/") depth += 1;
  return depth;
}

/**
 * Orders directory tokens ancestors-first, which is the order the host applies the paths of a single `watch` frame in.
 */
export function sortDirectoryPathsAncestorsFirst(
  directoryPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return directoryPaths.toSorted((left, right) => {
    const depthDelta = directoryDepthOf(left) - directoryDepthOf(right);
    return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
  });
}

/** Narrows an expansion set to the directories this client may legally watch, ordered ancestors-first. */
export function selectWatchableDirectoryPaths(
  expandedPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const expanded = new Set(expandedPaths);
  return sortDirectoryPathsAncestorsFirst(
    expandedPaths.filter((directoryPath) => {
      if (directoryPath === WORKSPACE_FILE_LIST_ROOT_PATH) return false;
      let parent = parentDirectoryPathOf(directoryPath);
      if (parent === null) return false;
      while (parent !== WORKSPACE_FILE_LIST_ROOT_PATH) {
        if (!expanded.has(parent)) return false;
        const next = parentDirectoryPathOf(parent);
        if (next === null) return false;
        parent = next;
      }
      return true;
    }),
  );
}

/**
 * Every ancestor directory token of a path, root-first: `"src/lib/a.ts"` -> `["src/", "src/lib/"]`.
 * Mirrors how the tree adapter derives directory rows from a flat path list, so a caller can name exactly the rows that have to be open for that path to be visible.
 */
export function ancestorDirectoryPathsOf(path: string): ReadonlyArray<string> {
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = withoutTrailingSlash.split("/");
  return segments
    .slice(0, -1)
    .map((_segment, index) => `${segments.slice(0, index + 1).join("/")}/`);
}

/** Folds the tree's live expansion back into the durable set. */
export function mergeExpandedDirectoryPaths(
  storedPaths: ReadonlyArray<string>,
  knownDirectoryPaths: ReadonlyArray<string>,
  isExpanded: (directoryPath: string) => boolean,
): ReadonlyArray<string> {
  const known = new Set(knownDirectoryPaths);
  return [
    ...knownDirectoryPaths.filter(isExpanded),
    ...storedPaths.filter((directoryPath) => !known.has(directoryPath)),
  ];
}

/** Flattens the covered listings into the tree adapter's inputs. */
export function projectWorkspaceFileList(
  listingsByDirectory: ReadonlyMap<string, WorkspaceFileListDirectoryListing>,
  coveredDirectoryPaths: ReadonlySet<string>,
): WorkspaceFileListProjection {
  const paths: string[] = [];
  const fileNameByPath = new Map<string, string>();
  const ignoredPaths: string[] = [];
  const ignoredDirectoryPaths = new Set<string>();
  let truncated = false;

  const coveredListings = [...coveredDirectoryPaths]
    .toSorted((left, right) => left.localeCompare(right))
    .flatMap((directoryPath) => {
      const listing = listingsByDirectory.get(directoryPath);
      return listing === undefined ? [] : [{ directoryPath, listing }];
    });

  for (const { listing } of coveredListings) {
    for (const entry of listing.entries) {
      if (entry.kind === "directory" && entry.ignored) {
        ignoredDirectoryPaths.add(entry.path);
      }
    }
  }

  for (const { directoryPath, listing } of coveredListings) {
    if (listing.truncated) truncated = true;
    const insideIgnoredDirectory = ignoredDirectoryPaths.has(directoryPath);
    for (const entry of listing.entries) {
      paths.push(entry.path);
      if (entry.kind !== "directory")
        fileNameByPath.set(entry.path, entry.name);
      if (entry.ignored && !insideIgnoredDirectory)
        ignoredPaths.push(entry.path);
    }
  }

  return { paths, fileNameByPath, ignoredPaths, truncated };
}
