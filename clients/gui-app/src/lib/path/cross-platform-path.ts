import {
  basename as patheBasename,
  dirname as patheDirname,
  isAbsolute as patheIsAbsolute,
  normalize as patheNormalize,
} from "pathe";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:(?:\/|$)/;
const WINDOWS_UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/;

export function normalizePath(path: string): string {
  return patheNormalize(path);
}

export function getBasename(path: string): string {
  return patheBasename(path);
}

export function getDirname(path: string): string {
  const directory = patheDirname(path);
  return directory === "." ? "" : directory;
}

/** Joins path segments and normalizes the result (POSIX-style, no filesystem access). */
export function joinPath(...segments: readonly string[]): string {
  const nonEmpty = segments.filter((segment) => segment.length > 0);
  return nonEmpty.length === 0 ? "." : normalizePath(nonEmpty.join("/"));
}

interface PathAuthority {
  /** The volume/share root, always ending in `/` (`/`, `C:/`, `//server/share/`). */
  readonly prefix: string;
  /** `basePath` with `prefix` stripped and no leading separator. */
  readonly rest: string;
}

/**
 * Splits `basePath` into its filesystem authority (a POSIX root, a Windows
 * drive, or a UNC share) and everything after it. The authority is the
 * floor `..` traversal must never climb above - `resolveAbsolutePath` joins
 * and walks `rest`, then re-prepends `prefix` unconditionally, so a drive
 * letter or UNC share can never be stripped or escaped by enough `../`
 * segments.
 *
 * `basePath` may arrive in native backslash form (`D:\repo`,
 * `\\server\share\nested`, a bound workspace root reported by a Windows
 * host) or with mixed separators - normalized to forward slashes FIRST
 * because `WINDOWS_DRIVE_PATH_PATTERN`/`WINDOWS_UNC_PATH_PATTERN` only match
 * the forward-slash form. Without this, a native-backslash drive base falls
 * through both patterns into the POSIX branch, which only strips a LEADING
 * separator - `D:\repo` has none (it starts with `D`), so the drive letter
 * ends up folded into `rest` and re-prefixed with a bogus POSIX `/` root
 * instead of being recognized as the authority itself.
 */
function pathAuthority(basePath: string): PathAuthority {
  const slashForm = basePath.replace(/\\/g, "/");
  const uncMatch = WINDOWS_UNC_PATH_PATTERN.exec(slashForm);
  if (uncMatch !== null) {
    return {
      prefix: `${uncMatch[0]}/`,
      rest: slashForm.slice(uncMatch[0].length).replace(/^\/+/, ""),
    };
  }
  const driveMatch = WINDOWS_DRIVE_PATH_PATTERN.exec(slashForm);
  if (driveMatch !== null) {
    return {
      prefix: `${slashForm.slice(0, 2)}/`,
      rest: slashForm.slice(2).replace(/^\/+/, ""),
    };
  }
  return { prefix: "/", rest: slashForm.replace(/^\/+/, "") };
}

/**
 * Resolves `relativePath` against `basePath` into a normalized absolute path
 * (string manipulation only, no filesystem access). `basePath` must already
 * be absolute. Traversal is clamped at `basePath`'s filesystem authority
 * (POSIX root, Windows drive, or UNC share): enough `../` segments to climb
 * above it lands AT the authority root rather than stripping the drive/share
 * or producing a non-absolute result, matching how a real filesystem clamps
 * `..` at its own root instead of erroring or escaping.
 */
export function resolveAbsolutePath(
  basePath: string,
  relativePath: string,
): string {
  const { prefix, rest } = pathAuthority(basePath);
  const joined = rest.length > 0 ? `${rest}/${relativePath}` : relativePath;
  const segments = joined
    .split(/[/\\]+/u)
    .filter((segment) => segment.length > 0 && segment !== ".");
  const clamped: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (clamped.length > 0) clamped.pop();
      continue;
    }
    clamped.push(segment);
  }
  return prefix + clamped.join("/");
}

export function isAbsolutePath(path: string): boolean {
  return patheIsAbsolute(path);
}

export function pathComparisonKey(
  path: string,
  caseInsensitive: boolean,
): string {
  const normalized = normalizePath(path);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isWindowsLikePath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    WINDOWS_DRIVE_PATH_PATTERN.test(normalized) ||
    WINDOWS_UNC_PATH_PATTERN.test(normalized)
  );
}

/**
 * Relativizes `path` against the most specific (longest) root in `roots`
 * that contains it, mirroring the file-mention convention: when bound roots
 * overlap (e.g. `/repo` and `/repo/sub`), the longest matching root wins.
 * Returns a normalized POSIX-style relative path, or `null` when `path` is
 * not under any root, or equals a root itself (a directory, not a file
 * under it).
 */
export function relativizeToWorkspaceRoot(
  roots: ReadonlyArray<string>,
  path: string,
): string | null {
  const best = roots.reduce<{
    readonly root: string;
    readonly relative: string;
  } | null>((acc, root) => {
    const relative = stripRootPrefix(root, path);
    if (relative === null) return acc;
    if (
      acc === null ||
      normalizePath(root).length > normalizePath(acc.root).length
    ) {
      return { root, relative };
    }
    return acc;
  }, null);
  if (best === null || best.relative.length === 0) return null;
  return best.relative;
}

/**
 * Splits on `/` only and resolves `.`/`..` segments without touching `\` -
 * unlike `pathe`'s `normalize`, which folds `\` into `/` on every platform.
 * POSIX paths may legally contain a literal backslash in a filename, so this
 * is used in place of `normalizePath` whenever neither side of a comparison
 * is Windows-like (drive-letter or UNC form).
 */
function normalizePosixPreservingBackslashes(path: string): string {
  const isAbsolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (isAbsolute) return `/${joined}`;
  return joined.length > 0 ? joined : ".";
}

function stripRootPrefix(root: string, path: string): string | null {
  const windowsLike = isWindowsLikePath(root) || isWindowsLikePath(path);
  const normalizedRoot = windowsLike
    ? normalizePath(root)
    : normalizePosixPreservingBackslashes(root);
  const normalizedPath = windowsLike
    ? normalizePath(path)
    : normalizePosixPreservingBackslashes(path);
  const rootKey = windowsLike ? normalizedRoot.toLowerCase() : normalizedRoot;
  const pathKey = windowsLike ? normalizedPath.toLowerCase() : normalizedPath;
  if (pathKey === rootKey) return "";
  const prefixKey = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  if (!pathKey.startsWith(prefixKey)) return null;
  const prefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedPath.slice(prefix.length);
}
