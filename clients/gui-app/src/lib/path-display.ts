/**
 * Path presentation helpers for folder listings.
 *
 * The identity of a folder row is its LEAF; the prefix is noise that repeats
 * on every row. These helpers turn a set of absolute host paths into the two
 * things a list needs: one shared base to state once, and a short remainder
 * per row.
 */

/** The separator a path already uses (a POSIX absolute path always wins). */
export function separatorOf(path: string): string {
  if (path.startsWith("/")) return "/";
  return path.includes("\\") ? "\\" : "/";
}

/**
 * Paths here are HOST-native, not client-native: a Windows host writes
 * `C:\Users\alice` and a POSIX host writes `/Users/alice`, so both
 * separators are accepted everywhere and a path is echoed back in the one it
 * already uses. Nothing has to be CONVERTED - Windows accepts `/` too.
 */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/**
 * `\\server\share` - the shortest thing on a UNC path that is still a root.
 * Windows accepts forward slashes here too (`//server/share`), so both lead-in
 * separators count; a genuine POSIX path virtually never starts with a doubled
 * slash, and POSIX itself leaves that prefix implementation-defined.
 */
const WINDOWS_UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

/** A path the host can resolve without a working directory. */
export function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    WINDOWS_DRIVE_ROOT.test(path) ||
    WINDOWS_UNC_ROOT.test(path)
  );
}

/**
 * `\` counts as a separator only once the path is known to be Windows-native.
 * On a POSIX host a backslash is an ordinary filename character, so a folder
 * genuinely named `foo\bar` must not be split at it - `/srv/foo\bar` browses
 * `/srv` filtered by `foo\bar`, never `/srv/foo` filtered by `bar`.
 */
export function lastSeparatorIndex(path: string): number {
  if (path.startsWith("/") && !WINDOWS_UNC_ROOT.test(path)) {
    return path.lastIndexOf("/");
  }
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/**
 * Length of the leading run that navigation may never chop into: `/`, `C:\`,
 * or `\\server\share`. Without it, going up from `C:\Users` would land on
 * `C:` - a drive-relative path, not a folder - instead of stopping at `C:\`.
 */
export function rootLengthOf(path: string): number {
  const unc = WINDOWS_UNC_ROOT.exec(path);
  if (unc !== null) return unc[0].length;
  if (WINDOWS_DRIVE_ROOT.test(path)) return 3;
  return 1;
}

/**
 * Path segments below the root, in order. Empty for a bare root.
 *
 * `\` counts as a separator only once the path is known to be Windows-native.
 * On a POSIX host a backslash is an ordinary filename character, so a folder
 * genuinely named `foo\bar` is ONE segment — splitting it would let
 * `commonBasePath` report a shared base (`/srv/foo/bar`) that names no
 * directory on that machine.
 */
export function segmentsOf(path: string): ReadonlyArray<string> {
  const rest = path.slice(rootLengthOf(path));
  const separators = separatorOf(path) === "/" ? /\// : /[\\/]/;
  return rest.split(separators).filter((segment) => segment !== "");
}

/** The last segment — the name the row is really about. */
export function leafOf(path: string): string {
  const segments = segmentsOf(path);
  return segments.at(-1) ?? path;
}

/**
 * Longest directory every path sits under, or null when stripping it would
 * buy nothing.
 *
 * Deliberately refuses three degenerate cases, because each produces a header
 * that costs a line and communicates nothing:
 *
 * - fewer than two paths (a single row has no *shared* anything);
 * - a base at the filesystem root (`/` is not news);
 * - a base that is one of the paths itself (that row's remainder is empty).
 */
export function commonBasePath(paths: ReadonlyArray<string>): string | null {
  if (paths.length < 2) return null;
  const first = paths[0];
  const root = first.slice(0, rootLengthOf(first));
  // Different roots (two drives, a UNC share and a local disk) share nothing.
  if (paths.some((path) => path.slice(0, rootLengthOf(path)) !== root)) {
    return null;
  }
  const separator = separatorOf(first);
  const segmentLists = paths.map((path) => segmentsOf(path));
  const reference = segmentsOf(first);
  const shortest = Math.min(...segmentLists.map((list) => list.length));
  let shared = 0;
  while (shared < shortest) {
    const candidate = reference[shared];
    if (segmentLists.some((list) => list[shared] !== candidate)) break;
    shared += 1;
  }
  // A base equal to one of the paths would leave that row with nothing to
  // show; keep one segment back so every row still has a name.
  if (shared >= shortest) shared = shortest - 1;
  if (shared <= 0) return null;
  // A UNC root (`\\\\server\\share`) carries no trailing separator, unlike `/`
  // and `C:\\`, so joining segments straight onto it would fuse the share name
  // to the first segment.
  const prefix = root.endsWith(separator) ? root : root + separator;
  return prefix + reference.slice(0, shared).join(separator);
}

/**
 * `path` written relative to `base`, or null when it does not sit under it.
 * A path equal to the base has no remainder and is reported as null too.
 */
export function relativeTo(path: string, base: string): string | null {
  const separator = separatorOf(base);
  const prefix = base.endsWith(separator) ? base : base + separator;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest === "" ? null : rest;
}

/** `~/work/x` when the path sits under the host's home. */
export function tildeCollapse(path: string, home: string | null): string {
  if (home === null || home === "") return path;
  if (path === home) return "~";
  const separator = separatorOf(home);
  const prefix = home.endsWith(separator) ? home : home + separator;
  if (!path.startsWith(prefix)) return path;
  return "~" + separator + path.slice(prefix.length);
}
