/**
 * Pure projection helpers for the `workspace.subscribeFileList` stream.
 *
 * The stream serves SINGLE-LEVEL listings keyed by the trailing-slash
 * directory token the client already received as that directory's entry
 * `path` (`"src/"`), with `""` naming the workspace root. Everything here
 * treats those tokens as opaque directory keys and only ever splits them on
 * `/` to answer parent/descendant questions - the same shape `@pierre/trees`
 * uses for its canonical directory paths, which is why the union of covered
 * listings can be handed to the tree adapter as a flat path list unchanged.
 */
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
 * True when `path` is `directoryPath` itself or lives underneath it. Both
 * arguments are directory tokens, so the trailing slash makes a prefix test
 * exact (`"src/"` never matches `"src-gen/x"`); the root token `""` is a
 * prefix of everything, which is what "the workspace root vanished" means.
 */
export function isWithinDirectory(
  path: string,
  directoryPath: string,
): boolean {
  return path.startsWith(directoryPath);
}

/**
 * The parent directory token of a directory token, or `null` for the root
 * (and for any non-canonical input, which never comes off the wire).
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
 * Orders directory tokens ancestors-first, which is the order the host applies
 * the paths of a single `watch` frame in.
 */
export function sortDirectoryPathsAncestorsFirst(
  directoryPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return directoryPaths.toSorted((left, right) => {
    const depthDelta = directoryDepthOf(left) - directoryDepthOf(right);
    return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
  });
}

/**
 * Narrows an expansion set to the directories this client may legally watch,
 * ordered ancestors-first.
 *
 * The contract enforces the ancestor precondition: a `watch` for a directory
 * whose parent is not covered is refused. Expansion state does not satisfy
 * that on its own - collapsing `"src/"` leaves a nested `"src/lib/"` marked
 * expanded (so re-expanding the parent restores the subtree), and watching it
 * while its parent is uncovered would be refused and pruned. Keeping only the
 * paths whose every ancestor is also expanded reproduces exactly "the rows the
 * user can see", which is what the contract says satisfies the precondition
 * for free. The root is always covered, so it is never named.
 */
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
 * Every ancestor directory token of a path, root-first: `"src/lib/a.ts"` ->
 * `["src/", "src/lib/"]`. Mirrors how the tree adapter derives directory rows
 * from a flat path list, so a caller can name exactly the rows that have to be
 * open for that path to be visible.
 */
export function ancestorDirectoryPathsOf(path: string): ReadonlyArray<string> {
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = withoutTrailingSlash.split("/");
  return segments
    .slice(0, -1)
    .map((_segment, index) => `${segments.slice(0, index + 1).join("/")}/`);
}

/**
 * Folds the tree's live expansion back into the durable set.
 *
 * A directory the tree does not know about YET must survive: on mount (and on
 * every reconnect) the restored set names directories whose listings have not
 * arrived, and reading the tree alone would report them collapsed and wipe the
 * restore before the batched `watch` frame could ask for them. A directory the
 * tree DOES know is authoritative - that is where a real collapse comes from.
 *
 * The mirror case is deliberate too: collapsing `"src/"` makes `"src/lib/"`
 * unknown (its rows go with the coverage), so the nested expansion is
 * remembered and comes back when the parent re-opens. `selectWatchableDirectoryPaths`
 * keeps those remembered paths out of the coverage request in the meantime.
 */
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

/**
 * Flattens the covered listings into the tree adapter's inputs.
 *
 * Only listings for CURRENTLY covered directories are read: a directory the
 * user collapsed keeps no rows, so re-expanding it shows the fresh listing the
 * host answers the new `watch` with rather than a stale snapshot.
 *
 * An entry inside an already-ignored directory contributes no `ignored` marker
 * of its own - the tree adapter inherits ignored status down a subtree, and
 * emitting one per entry would decorate every ancestor of, say, `node_modules`
 * with a "contains git status items" dot.
 */
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
