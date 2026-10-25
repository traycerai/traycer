export interface CanvasBoardDestination {
  readonly path: string;
  readonly search: string;
  readonly hash: string;
}

/** Resolve only within this canvas's root, never across artifacts or schemes. */
export function resolveCanvasBoardLink(
  fromPath: string,
  href: string,
  boardPaths: readonly string[],
): CanvasBoardDestination | null {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) ||
    href.startsWith("/") ||
    href.includes("\\")
  )
    return null;
  const path = href.split(/[?#]/, 1)[0];
  if (href === "" || [...href].some((char) => char.charCodeAt(0) < 32))
    return null;
  const suffix = href.slice(path.length);
  const hashAt = suffix.indexOf("#");
  const search = suffix.startsWith("?")
    ? suffix.slice(0, hashAt < 0 ? undefined : hashAt)
    : "";
  const hash = hashAt < 0 ? "" : suffix.slice(hashAt);
  if (path === "")
    return boardPaths.includes(fromPath)
      ? { path: fromPath, search, hash }
      : null;
  const target = resolveBoardPath(fromPath, path);
  return target !== null && boardPaths.includes(target)
    ? { path: target, search, hash }
    : null;
}

function resolveBoardPath(fromPath: string, path: string): string | null {
  const segments = fromPath.split("/").slice(0, -1);
  for (const encoded of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    )
      return null;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
}
